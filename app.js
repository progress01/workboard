// =====================================================================
// 白板 & 心流沙盒 v3.4
// ---------------------------------------------------------------------
// v3.0 重整重點（資料邏輯）：
// 1. 所有修改只走一個入口 app.saveToLocal()（= store.markDirty）：
//    0.4 秒後統一寫入本機，寫入失敗會在畫面上明確顯示，不再默默失敗。
// 2. 每張卡片自動記錄 updatedAt；刪除會留下「刪除紀錄」。
//    雲端存／載時用它逐張比對，不再整份互相覆蓋。
// 3. 雲端仍是手動「存雲端／載雲端」，但會先比對：
//    雲端被其他裝置更新過、或本機有未上傳的修改時，先列出差異，預設「合併」。
// 4. 任何覆蓋前都會先在本機瀏覽器（IndexedDB）留一份版本備份；
//    刪除的卡片進「最近刪除」，可以救回來。
// 5. 計時器改用「開始時間」計算，背景分頁、闔上筆電、重新整理都不會少算或遺失。
// =====================================================================

// === Firebase 配置 ===
const firebaseConfig = {
    apiKey: "AIzaSyAIY9PU-bDLktkTpLSmFKRe1uepvWCKEiU",
    authDomain: "maplestoryboss.firebaseapp.com",
    projectId: "maplestoryboss",
    storageBucket: "maplestoryboss.firebasestorage.app",
    messagingSenderId: "198034430854",
    appId: "1:198034430854:web:527ffcee039e223b972a07"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
const provider = new firebase.auth.GoogleAuthProvider();

const APP_VERSION = '3.4.2';
const SCHEMA_VERSION = 3;
const CLOUD_DOC_SOFT_LIMIT = 750 * 1024;   // 超過時提醒
const CLOUD_DOC_HARD_LIMIT = 1000 * 1000;  // Firestore 單一文件上限約 1 MiB，保守一點
const POMODORO_MS = 25 * 60 * 1000;

// 公司工時表的工作類別（工時紀錄可選；工作日誌與 Excel 會照這個輸出）
const WORK_CATEGORIES = [
    'P01 文件/簡報製作', 'P02 問題追蹤/派工/時程控管', 'P03 網站企劃/系統規劃', 'P04 系統測試/網站檢核', 'P05 資料蒐集/盤點/分析',
    'U01 內部會議/討論/聯繫', 'U02 外部會議/討論/聯繫', 'U03 請款/報表/公文作業', 'U04 工作日誌填寫', 'U05 課程/訓練/進修',
    'U06 公司/部門/行政事務', 'U07 其他', '000 休假', '執行工作'
];
// 公司工時表的專案清單（工時表只能選這些）
const COMPANY_PROJECTS = [
    '環境部「115-116年度內外網系統維運暨功能擴增案」',
    '化學物質管理署「114-116年度中英文全球資訊網與業務網站整合、維運暨功能擴增案」',
    '氣候變遷署「114-115年度全球資訊網系統維運案」',
    '公司/部門事務'
];
function workCategoryOptions(selected, emptyLabel = '（不指定）') {
    const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const list = selected && !WORK_CATEGORIES.includes(selected) ? [...WORK_CATEGORIES, selected] : WORK_CATEGORIES;
    return `<option value="">${emptyLabel}</option>` + list.map(c => `<option value="${esc(c)}" ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

function defaultMeta() {
    return {
        schema: SCHEMA_VERSION,
        updatedAt: 0,        // 最後一次內容變更時間（ms，僅供參考；同步判斷用本機計數，不比時鐘）
        miscUpdatedAt: 0,    // 分頁名稱、筆記本、詰棋等非卡片資料的變更時間
        tombstones: { cards: {}, tabs: {}, nodes: {} }  // 刪除紀錄：id → 刪除時間
    };
}

function defaultState() {
    return {
        tabs: [{ id: 'main', name: '主工作區' }],
        activeTabId: 'main',
        workspaces: { 'main': [] },
        nodes: { 'main': [] },
        globalNotebook: { template: 'free', free: '', matrix: { q1:'', q2:'', q3:'', q4:'' } },
        tsumego: { isOpen: false, currentColor: 'black', stones: [] },
        view: 'timeline',
        filters: { keyword: '', activeProject: null },
        ganttFilters: { project: '', month: '', mode: 'schedule', scale: 'week' },
        chronicleFilters: { scope: 'all', project: '' },
        showProjectBar: false,
        meta: defaultMeta(),
        // 心流沙盒執行期狀態。計時資料另存在 whiteboard_timer_<uid>，不進雲端。
        sandbox: {
            activeTaskId: null,
            mode: 'FLEXIBLE', timerStatus: 'IDLE', timerInterval: null,
            timerTaskId: null, segStart: null, segments: [], lastSeenAt: null,
            deadlineTask: '', deadlineDate: ''
        }
    };
}

function defaultPrefs() {
    return { view: 'timeline', activeTabId: 'main', ganttScale: 'week', ganttMode: 'schedule', chronicleScope: 'all', showProjectBar: false, collapsedGroups: {}, panels: {} };
}

function deepClone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

// === 核心 App 邏輯 ===
const app = {
    currentUser: null,
    state: defaultState(),
    prefs: defaultPrefs(),
    _setupDone: false,

    // 工作紀錄的畫面狀態只存在記憶體，不寫入 localStorage / Firebase。
    entryUi: {},

    init() {
        this.ui.installGlobalHandlers();
        auth.onAuthStateChanged((user) => {
            if (user) {
                this.currentUser = user;
                document.getElementById('login-screen').style.display = 'none';
                document.getElementById('app-content').style.display = 'block';
                if (!this._setupDone) {
                    this.injectStarPoints();
                    this.setupMatrixDrag();
                    this.setupTsumegoDrag();
                    this.sandbox.initUI();
                    this._setupDone = true;
                }
                this.state = defaultState();
                this.entryUi = {};
                this.worktime.planningUi = {};
                this.prefs = this.store.loadPrefs();
                const hadLocal = this.store.loadLocal();
                this.applyPrefs();
                this.sandbox.syncDeadlineInputs();
                this.sandbox.restoreTimer();
                this.switchView(this.state.view || 'timeline');
                this.renderTsumegoStones();
                this.ui.renderSyncStatus();
                this.cloud.checkOnStartup(hadLocal);
                this.backup.dailySnapshot();
            } else {
                this.store.flush();
                this.sandbox.stopTick();
                this.currentUser = null;
                this.state = defaultState();
                this.entryUi = {};
                document.getElementById('login-screen').style.display = 'flex';
                document.getElementById('app-content').style.display = 'none';
            }
        });
    },

    login() { auth.signInWithPopup(provider).catch(err => alert("登入失敗: " + err.message)); },
    async logout() {
        this.store.flush();
        const unsynced = this.cloud.hasUnsynced();
        const ok = await this.ui.dialog({
            title: '登出',
            html: unsynced
                ? '<p>⚠️ 這台裝置有<strong>還沒上傳到雲端</strong>的修改。登出不會刪除本機資料，下次用同一個帳號登入還在；但若要在別台裝置看到，請先按「☁️ 存雲端」。</p>'
                : '<p>本機資料與雲端一致。登出不會刪除本機資料。</p>',
            buttons: [{ label: '取消', value: false }, { label: '登出', value: true, primary: true }]
        });
        if (ok) auth.signOut();
    },

    // 所有修改後都呼叫這個；實際寫入會延遲 0.4 秒合併處理。
    saveToLocal() { this.store.markDirty(); },

    applyPrefs() {
        const p = this.prefs;
        const s = this.state;
        s.view = ['timeline','matrix','chronicle','gantt','calendar','report','sandbox'].includes(p.view) ? p.view : 'timeline';
        if (s.view === 'sandbox') s.view = 'timeline';
        s.activeTabId = s.tabs.some(t => t.id === p.activeTabId) ? p.activeTabId : s.tabs[0].id;
        s.ganttFilters.scale = ['day','week','month'].includes(p.ganttScale) ? p.ganttScale : 'week';
        s.ganttFilters.mode = p.ganttMode === 'time' ? 'time' : 'schedule';
        s.chronicleFilters.scope = p.chronicleScope === 'current' ? 'current' : 'all';
        if (p.showProjectBar && !s.showProjectBar) this.toggleProjectBar(true);
    },

    rememberPrefs() {
        if (!this.currentUser) return;
        const s = this.state;
        Object.assign(this.prefs, {
            view: s.view, activeTabId: s.activeTabId,
            ganttScale: s.ganttFilters?.scale || 'week', ganttMode: s.ganttFilters?.mode || 'schedule',
            chronicleScope: s.chronicleFilters?.scope || 'all', showProjectBar: !!s.showProjectBar
        });
        this.store.savePrefs();
    },

    panelOpen(source, cardId, panel) {
        const v = this.prefs.panels?.[`${source}:${cardId}`]?.[panel];
        return v === undefined ? false : !!v;
    },
    setPanelOpen(source, cardId, panel, open) {
        if (!this.prefs.panels) this.prefs.panels = {};
        const key = `${source}:${cardId}`;
        if (!this.prefs.panels[key]) this.prefs.panels[key] = {};
        this.prefs.panels[key][panel] = !!open;
        this.store.savePrefs();
    },

    // ==========================================
    // 💾 本機儲存（唯一寫入點）
    // ==========================================
    store: {
        version: 0,
        pending: false,
        flushTimer: null,
        hashes: null,
        lastSavedAt: 0,
        lastSize: 0,
        sessionId: Math.random().toString(36).slice(2, 10),

        key(kind = 'state') { return `whiteboard_${kind}_${app.currentUser.uid}`; },

        // 同步記帳：只在這台裝置（同一瀏覽器的各分頁共用），不上雲端。
        // rev 每次內容有變動 +1；syncedRev 是最後一次「本機 = 雲端」時的 rev。只比自己的計數，不比不同裝置的時鐘。
        syncInfo() {
            const base = { rev: 0, syncedRev: 0, cloudVersion: 0, cloudSavedAt: 0, lastChangeAt: 0 };
            try { return { ...base, ...JSON.parse(localStorage.getItem(this.key('sync')) || '{}') }; }
            catch { return base; }
        },
        setSyncInfo(patch) {
            const info = { ...this.syncInfo(), ...patch };
            try { localStorage.setItem(this.key('sync'), JSON.stringify(info)); } catch (err) { console.warn('同步記帳未保存', err); }
            return info;
        },
        bumpRev() {
            const info = this.syncInfo();
            return this.setSyncInfo({ rev: (info.rev || 0) + 1, lastChangeAt: Date.now() }).rev;
        },

        serialize() {
            const s = app.state;
            return deepClone({
                tabs: s.tabs, workspaces: s.workspaces, nodes: s.nodes,
                globalNotebook: s.globalNotebook,
                tsumego: { stones: s.tsumego.stones },
                sandbox: { deadlineTask: s.sandbox.deadlineTask, deadlineDate: s.sandbox.deadlineDate },
                meta: s.meta
            });
        },

        // 把一份資料（本機、雲端、備份檔）套用成目前狀態。回傳整理時是否有修正舊資料。
        apply(data) {
            const result = app.migrate.normalize(data, true);
            const doc = result.doc;
            const s = app.state;
            s.tabs = doc.tabs; s.workspaces = doc.workspaces; s.nodes = doc.nodes;
            s.globalNotebook = doc.globalNotebook;
            s.tsumego.stones = doc.tsumego.stones;
            s.sandbox.deadlineTask = doc.sandbox.deadlineTask;
            s.sandbox.deadlineDate = doc.sandbox.deadlineDate;
            s.meta = doc.meta;
            if (!s.tabs.some(t => t.id === s.activeTabId)) s.activeTabId = s.tabs[0].id;
            if (!s.nodes[s.activeTabId]) s.nodes[s.activeTabId] = [];
            if (s.sandbox.activeTaskId && !app.worktime.getCard(s.sandbox.activeTaskId)) s.sandbox.activeTaskId = null;
            this.hashes = this.computeHashes();
            this.version++;
            return result.changed;
        },

        // 套用並立刻寫入；用在載入雲端、合併、還原備份。synced=true 表示「現在本機 = 雲端」。
        applyAndSave(doc, { cloudVersion, synced } = {}) {
            this.apply(doc);
            this.pending = true;
            const ok = this.flush(true);
            const rev = this.bumpRev();
            const patch = {};
            if (cloudVersion !== undefined) patch.cloudVersion = cloudVersion;
            if (synced && ok) patch.syncedRev = rev;
            this.setSyncInfo(patch);
            return ok;
        },

        loadLocal() {
            let raw = null;
            try { raw = localStorage.getItem(this.key()); } catch (err) { console.warn(err); }
            if (!raw) { this.apply({}); return false; }
            try {
                const changed = this.apply(JSON.parse(raw));
                // 整理舊資料時有修正（例如補上工時紀錄的 id），立刻存回去，下次載入結果才會一致。
                if (changed) { this.pending = true; this.flush(true); }
                return true;
            } catch (err) {
                console.error('本機資料無法解析', err);
                app.backup.save('本機資料無法讀取時的原始內容', raw);
                app.ui.banner('error', '本機資料格式損毀，原始內容已另存在「🗂 資料 → 版本備份」。目前以空白狀態開啟，可以按「📥 載雲端」取回雲端資料。');
                this.apply({});
                return false;
            }
        },

        markDirty() {
            if (!app.currentUser) return;
            this.version++;
            this.pending = true;
            clearTimeout(this.flushTimer);
            this.flushTimer = setTimeout(() => this.flush(), 400);
            app.ui.setSaveState('saving');
        },

        flush(force = false) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
            if (!app.currentUser || (!this.pending && !force)) return true;
            const changed = this.trackChanges();
            if (changed) this.bumpRev();
            try {
                const data = this.serialize();
                const json = JSON.stringify({ ...data, meta: { ...data.meta, writer: this.sessionId } });
                localStorage.setItem(this.key(), json);
                this.pending = false;
                this.lastSavedAt = Date.now();
                this.lastSize = json.length;
                app.ui.setSaveState('saved');
                return true;
            } catch (err) {
                console.error('本機儲存失敗', err);
                app.ui.setSaveState('error', err);
                return false;
            }
        },

        cardSig(obj) {
            if (!obj) return '';
            const { updatedAt, ...rest } = obj;
            return JSON.stringify(rest);
        },

        computeHashes() {
            const s = app.state;
            const cards = {}, nodes = {};
            for (const tabId in s.workspaces) (s.workspaces[tabId] || []).forEach(c => { if (c?.id) cards[c.id] = `${tabId}|${this.cardSig(c)}`; });
            for (const tabId in s.nodes) (s.nodes[tabId] || []).forEach(n => { if (n?.id) nodes[n.id] = `${tabId}|${this.cardSig(n)}`; });
            const tabs = {};
            s.tabs.forEach(t => { tabs[t.id] = t.name; });
            const misc = JSON.stringify([s.tabs, s.globalNotebook, s.tsumego.stones, s.sandbox.deadlineTask, s.sandbox.deadlineDate]);
            return { cards, nodes, tabs, misc };
        },

        // 比對上一次寫入後的差異：有變動的卡片／節點蓋上 updatedAt，刪掉的留下刪除紀錄。回傳是否有變動。
        trackChanges() {
            const s = app.state;
            const prev = this.hashes || this.computeHashes();
            const next = this.computeHashes();
            const now = Date.now();
            const tomb = s.meta.tombstones;
            let changed = false;
            for (const tabId in s.workspaces) (s.workspaces[tabId] || []).forEach(c => {
                if (c?.id && prev.cards[c.id] !== next.cards[c.id]) { c.updatedAt = now; delete tomb.cards[c.id]; changed = true; }
            });
            Object.keys(prev.cards).forEach(id => { if (!(id in next.cards)) { tomb.cards[id] = now; changed = true; } });
            for (const tabId in s.nodes) (s.nodes[tabId] || []).forEach(n => {
                if (n?.id && prev.nodes[n.id] !== next.nodes[n.id]) { n.updatedAt = now; delete tomb.nodes[n.id]; changed = true; }
            });
            Object.keys(prev.nodes).forEach(id => { if (!(id in next.nodes)) { tomb.nodes[id] = now; changed = true; } });
            Object.keys(prev.tabs).forEach(id => { if (!(id in next.tabs)) { tomb.tabs[id] = now; } });
            Object.keys(next.tabs).forEach(id => { delete tomb.tabs[id]; });
            if (prev.misc !== next.misc) { s.meta.miscUpdatedAt = now; changed = true; }
            if (changed) s.meta.updatedAt = now;
            this.pruneTombstones();
            this.hashes = next;
            return changed;
        },

        pruneTombstones() {
            const limit = Date.now() - 365 * 24 * 3600 * 1000;
            const tomb = app.state.meta.tombstones;
            ['cards', 'tabs', 'nodes'].forEach(kind => {
                Object.keys(tomb[kind] || {}).forEach(id => { if (tomb[kind][id] < limit) delete tomb[kind][id]; });
            });
        },

        // 另一個分頁寫入同一份資料時同步過來，避免兩個分頁互相蓋掉。
        onStorage(e) {
            if (!app.currentUser) return;
            if (e.key === app.sandbox.timerKey()) { app.sandbox.adoptStoredTimer(); return; }
            if (e.key === this.key('sync')) { app.ui.renderSyncStatus(); return; }
            if (e.key !== this.key() || !e.newValue) return;
            let data;
            try { data = JSON.parse(e.newValue); } catch { return; }
            if (data?.meta?.writer === this.sessionId) return;
            if (this.pending) {
                if (this.trackChanges()) this.bumpRev();
                const { doc } = app.sync.mergeDocs(this.serialize(), data, '另一個分頁', null);
                this.apply(doc);
                this.pending = true;
                this.flush(true);
            } else {
                this.apply(data);
            }
            app.ui.renderWhenIdle();
            app.ui.renderSyncStatus();
            app.ui.toast('已同步另一個分頁的修改');
        },

        loadPrefs() {
            try {
                const raw = localStorage.getItem(this.key('ui'));
                return raw ? { ...defaultPrefs(), ...JSON.parse(raw) } : defaultPrefs();
            } catch { return defaultPrefs(); }
        },

        savePrefs() {
            if (!app.currentUser) return;
            try { localStorage.setItem(this.key('ui'), JSON.stringify(app.prefs)); } catch (err) { console.warn('偏好設定未保存', err); }
        },

        sizeOf(obj) {
            try { return new Blob([JSON.stringify(obj)]).size; } catch { return 0; }
        }
    },

    // ==========================================
    // 🧹 舊資料整理（每次載入都會跑；結果固定，不同裝置整理同一份資料會得到一樣的結果）
    // ==========================================
    migrate: {
        normalize(input, withFlag = false) {
            const src = (input && typeof input === 'object') ? deepClone(input) : {};
            const before = JSON.stringify([src.tabs, src.workspaces, src.nodes]);
            const out = {};
            const meta = { ...defaultMeta(), ...(src.meta && typeof src.meta === 'object' ? src.meta : {}) };
            ['writer', 'cloudSyncedAt', 'cloudVersion', 'cloudSavedAt'].forEach(k => delete meta[k]);
            meta.tombstones = {
                cards: { ...(meta.tombstones?.cards || {}) },
                tabs: { ...(meta.tombstones?.tabs || {}) },
                nodes: { ...(meta.tombstones?.nodes || {}) }
            };
            meta.schema = SCHEMA_VERSION;
            out.meta = meta;

            let tabs = Array.isArray(src.tabs) ? src.tabs.filter(t => t && t.id) : [];
            const seenTab = new Set();
            tabs = tabs.filter(t => { if (seenTab.has(t.id)) return false; seenTab.add(t.id); return true; })
                .map(t => ({ id: String(t.id), name: String(t.name ?? '未命名分頁') }));
            if (!tabs.length) tabs.push({ id: 'main', name: '主工作區' });

            const workspaces = (src.workspaces && typeof src.workspaces === 'object') ? src.workspaces : {};
            const nodes = (src.nodes && typeof src.nodes === 'object') ? src.nodes : {};

            // 有卡片或發想節點、但沒有對應分頁的資料（舊版雲端合併殘留）：建立看得到的分頁，讓你決定留或刪。
            const orphanIds = new Set([
                ...Object.keys(workspaces).filter(id => Array.isArray(workspaces[id]) && workspaces[id].length),
                ...Object.keys(nodes).filter(id => Array.isArray(nodes[id]) && nodes[id].length)
            ]);
            [...orphanIds].sort().forEach(tabId => {
                if (!tabs.some(t => t.id === tabId)) tabs.push({ id: tabId, name: '♻ 找回的舊分頁' });
            });
            out.tabs = tabs;

            // 舊資料沒有 id 的工時／工作紀錄：用「內容 + 第幾筆」產生固定 id，兩台裝置會算出一樣的結果。
            const fixListIds = (list, prefix, owner) => {
                if (!Array.isArray(list)) return list;
                const seen = {};
                const used = new Set();
                return list.filter(x => x && typeof x === 'object').map(x => {
                    if (x.id && !used.has(x.id)) { used.add(x.id); return x; }
                    const { id, ...rest } = x;
                    const key = `${owner}|${JSON.stringify(rest)}`;
                    seen[key] = (seen[key] || 0) + 1;
                    let nid = `${prefix}_legacy_${app.sync.hash(key)}_${seen[key]}`;
                    while (used.has(nid)) nid += 'x';
                    used.add(nid);
                    return { ...x, id: nid };
                });
            };

            // 先找出重複的卡片 id：重複的每一張都依「自己的內容」改成固定的新 id（不看排列順序），兩台裝置會算出一樣的結果。
            const idCount = {};
            tabs.forEach(t => (Array.isArray(workspaces[t.id]) ? workspaces[t.id] : []).forEach(c => { if (c && c.id) idCount[c.id] = (idCount[c.id] || 0) + 1; }));
            const cardFingerprint = c => app.sync.hash([c.title || '', c.content || '', c.project || '', c.dateSingle || '', c.dateStart || '', (Array.isArray(c.workLogs) ? c.workLogs : []).map(l => l?.id || l?.workDate || '').join(',')].join('|'));
            const seenCard = {};
            const fpSeen = {};
            out.workspaces = {};
            tabs.forEach(t => {
                const list = Array.isArray(workspaces[t.id]) ? workspaces[t.id] : [];
                out.workspaces[t.id] = list.filter(c => c && typeof c === 'object').map(card => {
                    if (!card.id || idCount[card.id] > 1) {
                        // 沒有 id，或舊版同一毫秒建立造成 id 撞號
                        const baseId = card.id ? `${card.id}__` : 'card_legacy_';
                        const fp = `${baseId}${cardFingerprint(card)}`;
                        fpSeen[fp] = (fpSeen[fp] || 0) + 1;
                        card.id = fpSeen[fp] > 1 ? `${fp}_${fpSeen[fp]}` : fp;
                    }
                    while (seenCard[card.id]) card.id += 'x';
                    seenCard[card.id] = true;
                    // 文字與日期欄位一律存成字串（舊資料或手動編輯可能留下數字等其他型別）
                    ['title', 'content', 'project', 'category', 'deliverable', 'acceptance', 'nextStep', 'nextAction', 'waitingWho', 'waitingWhat', 'followUpDate',
                     'chronicleSummary', 'chronicleDate', 'dateStart', 'dateEnd', 'dateSingle', 'actualStart', 'actualEnd', 'timeCategory', 'dateMode', 'color'].forEach(k => {
                        if (card[k] !== undefined && card[k] !== null && typeof card[k] !== 'string') card[k] = String(card[k]);
                    });
                    if (card.title === undefined || card.title === null) card.title = '';
                    if (card.content === undefined || card.content === null) card.content = '';
                    if (card.project === undefined || card.project === null) card.project = '';
                    if (card.workLogs !== undefined) card.workLogs = Array.isArray(card.workLogs) ? fixListIds(card.workLogs, 'work', card.id) : [];
                    if (card.entries !== undefined) card.entries = Array.isArray(card.entries) ? fixListIds(card.entries, 'entry', card.id) : [];
                    if (!card.color) card.color = 'blue';
                    if (card.status === undefined || card.status === null || card.status === '') card.status = 0;
                    if (typeof card.status !== 'number') card.status = Number(card.status) || 0;
                    // workflow 舊白板用 nextAction；這版以 nextStep 為主。只在 nextStep 空著時帶入，不覆蓋任何一邊。
                    if (!String(card.nextStep || '').trim() && String(card.nextAction || '').trim()) card.nextStep = card.nextAction;
                    if (String(card.nextStep || '').trim() && !String(card.nextAction || '').trim()) card.nextAction = card.nextStep;
                    return card;
                });
            });

            out.nodes = {};
            const nodeCount = {};
            tabs.forEach(t => (Array.isArray(nodes[t.id]) ? nodes[t.id] : []).forEach(n => { if (n && n.id) nodeCount[n.id] = (nodeCount[n.id] || 0) + 1; }));
            const seenNode = {};
            const nodeFp = {};
            tabs.forEach(t => {
                const list = Array.isArray(nodes[t.id]) ? nodes[t.id] : [];
                out.nodes[t.id] = list.filter(n => n && typeof n === 'object').map(n => {
                    if (!n.id || nodeCount[n.id] > 1) {
                        const fp = `${n.id ? n.id + '__' : 'node_legacy_'}${app.sync.hash(`${n.text || ''}|${n.tag || ''}|${n.project || ''}`)}`;
                        nodeFp[fp] = (nodeFp[fp] || 0) + 1;
                        n.id = nodeFp[fp] > 1 ? `${fp}_${nodeFp[fp]}` : fp;
                    }
                    while (seenNode[n.id]) n.id += 'x';
                    seenNode[n.id] = true;
                    return n;
                });
            });

            const nb = src.globalNotebook && typeof src.globalNotebook === 'object' ? src.globalNotebook : {};
            out.globalNotebook = {
                template: nb.template === 'matrix' ? 'matrix' : 'free',
                free: String(nb.free ?? ''),
                matrix: { q1: '', q2: '', q3: '', q4: '', ...(nb.matrix || {}) }
            };
            out.tsumego = { stones: Array.isArray(src.tsumego?.stones) ? src.tsumego.stones : [] };
            out.sandbox = {
                deadlineTask: String(src.sandbox?.deadlineTask ?? ''),
                deadlineDate: String(src.sandbox?.deadlineDate ?? '')
            };
            if (!withFlag) return out;
            return { doc: out, changed: JSON.stringify([out.tabs, out.workspaces, out.nodes]) !== before };
        }
    },

    makeId(prefix = 'card') { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; },

    // 從卡片 id 推回建立時間（card_<毫秒>...）
    idTime(id) {
        const m = String(id || '').match(/_(\d{12,14})/);
        return m ? Number(m[1]) : 0;
    },

    // ==========================================
    // 🔀 合併：逐張卡片、逐個欄位比對，不整份覆蓋
    // ==========================================
    sync: {
        TEXT_FIELDS: { title: '標題', content: '內容', project: '專案', nextStep: '下一步', nextAction: '下一步（舊）', deliverable: '要交出什麼', acceptance: '怎樣算完成', chronicleSummary: '大事記摘要', category: '任務分類', waitingWho: '在等誰', waitingWhat: '在等什麼' },
        FIELD_LABELS: { followUpDate: '追蹤日', status: '狀態', color: '標記', dateSingle: '日期', dateStart: '開始日', dateEnd: '結束日', dateMode: '日期模式', isMemo: '卡片用途', progress: '進度', plannedMinutes: '預估工時', actualStart: '實際開始', actualEnd: '實際完成', chroniclePinned: '大事記', chronicleDate: '大事記日期', excludeFromGantt: '甘特顯示' },
        BLOCK_TEXT: ['content', 'deliverable', 'acceptance', 'chronicleSummary'],
        LIST_FIELDS: ['workLogs', 'entries'],

        isBlankCard(c) {
            return !String(c?.title || '').trim() && !String(c?.content || '').trim()
                && !(c?.workLogs || []).length && !(c?.entries || []).length
                && !String(c?.nextStep || '').trim() && !String(c?.deliverable || '').trim();
        },

        hash(str) {
            let h = 0x811c9dc5;
            const s = String(str);
            for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
            return (h >>> 0).toString(36);
        },
        fieldHash(v) { return this.hash(v === undefined ? 'undefined' : JSON.stringify(v)); },
        cardHash(c) { return this.hash(app.store.cardSig(c)); },
        isEmpty(v) { return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length); },

        miscFields(doc) {
            const nb = doc.globalNotebook || {};
            return {
                template: nb.template, free: nb.free,
                q1: nb.matrix?.q1, q2: nb.matrix?.q2, q3: nb.matrix?.q3, q4: nb.matrix?.q4,
                stones: doc.tsumego?.stones || [],
                deadlineTask: doc.sandbox?.deadlineTask, deadlineDate: doc.sandbox?.deadlineDate
            };
        },

        // 「上次和雲端一致時」的指紋，用來判斷是哪一邊改了什麼。只存在本機。
        buildBase(docRaw) {
            const doc = app.migrate.normalize(docRaw);
            const cards = {};
            Object.entries(doc.workspaces).forEach(([tabId, list]) => list.forEach(c => {
                const f = {};
                Object.keys(c).forEach(k => { if (k !== 'updatedAt' && !this.LIST_FIELDS.includes(k)) f[k] = this.fieldHash(c[k]); });
                cards[c.id] = { h: this.cardHash(c), tab: tabId, f, logs: (c.workLogs || []).map(x => x?.id).filter(Boolean), entries: (c.entries || []).map(x => x?.id).filter(Boolean) };
            }));
            const nodes = {};
            Object.entries(doc.nodes).forEach(([tabId, list]) => list.forEach(n => { nodes[n.id] = { h: this.cardHash(n), tab: tabId }; }));
            const tabs = {};
            doc.tabs.forEach(t => { tabs[t.id] = this.fieldHash(t.name); });
            const misc = {};
            Object.entries(this.miscFields(doc)).forEach(([k, v]) => { misc[k] = this.fieldHash(v); });
            return { at: Date.now(), cards, nodes, tabs, misc };
        },
        baseKey() { return app.store.key('syncbase'); },
        loadBase() {
            try { const raw = localStorage.getItem(this.baseKey()); return raw ? JSON.parse(raw) : null; } catch { return null; }
        },
        saveBase(docRaw) {
            try { localStorage.setItem(this.baseKey(), JSON.stringify(this.buildBase(docRaw))); return true; }
            catch (err) { console.warn('同步基準未保存（下次合併會較保守）', err); this.clearBase(); return false; }
        },
        clearBase() { try { localStorage.removeItem(this.baseKey()); } catch {} },

        // 整份內容是否相同（不看時間戳與記帳欄位）
        docSig(docRaw) {
            const d = app.migrate.normalize(docRaw);
            const cards = [];
            Object.entries(d.workspaces).forEach(([tabId, list]) => list.forEach(c => cards.push(`${c.id}|${tabId}|${app.store.cardSig(c)}`)));
            const nodes = [];
            Object.entries(d.nodes).forEach(([tabId, list]) => list.forEach(n => nodes.push(`${n.id}|${tabId}|${app.store.cardSig(n)}`)));
            return this.hash(JSON.stringify([cards.sort(), nodes.sort(), d.tabs.map(t => `${t.id}|${t.name}`).sort(), this.miscFields(d)]));
        },
        sameContent(a, b) { return this.docSig(a) === this.docSig(b); },

        // 三方比對一個值：base 指紋可為 undefined（沒有基準）。回傳 { value, conflict, rescuedText }
        pick(av, bv, baseHash, aWins) {
            if (JSON.stringify(av) === JSON.stringify(bv)) return { value: av };
            if (baseHash !== undefined) {
                if (this.fieldHash(av) === baseHash) return { value: bv };
                if (this.fieldHash(bv) === baseHash) return { value: av };
            } else {
                if (this.isEmpty(av)) return { value: bv };
                if (this.isEmpty(bv)) return { value: av };
            }
            return { value: aWins ? av : bv, loser: aWins ? bv : av, conflict: true };
        },

        mergeList(la, lb, baseIds, preferA) {
            if (!Array.isArray(la) && !Array.isArray(lb)) return undefined;
            const baseSet = baseIds ? new Set(baseIds) : null;
            const ida = new Set((la || []).map(x => x?.id).filter(Boolean));
            const idb = new Set((lb || []).map(x => x?.id).filter(Boolean));
            const byIdB = new Map((lb || []).filter(x => x?.id).map(x => [x.id, x]));
            const out = [];
            const seen = new Set();
            (la || []).forEach(x => {
                if (!x?.id) { out.push(deepClone(x)); return; }
                if (baseSet && baseSet.has(x.id) && !idb.has(x.id)) return; // 另一邊刪掉了
                const y = byIdB.get(x.id);
                let pick = x;
                if (y && JSON.stringify(x) !== JSON.stringify(y)) {
                    const ux = String(x.updatedAt || ''), uy = String(y.updatedAt || '');
                    pick = ux === uy ? (preferA ? x : y) : (ux > uy ? x : y);
                }
                seen.add(x.id);
                out.push(deepClone(pick));
            });
            (lb || []).forEach(y => {
                if (!y?.id) { if (!(la || []).some(x => !x?.id && JSON.stringify(x) === JSON.stringify(y))) out.push(deepClone(y)); return; }
                if (seen.has(y.id)) return;
                if (baseSet && baseSet.has(y.id) && !ida.has(y.id)) return; // 這邊刪掉了
                seen.add(y.id);
                out.push(deepClone(y));
            });
            return out;
        },

        // 沒有同步基準也沒有時間戳時，猜哪一邊比較完整（內容包含另一邊、工時較多）
        aLooksNewer(a, b) {
            const ua = Number(a.updatedAt) || 0, ub = Number(b.updatedAt) || 0;
            if (ua && ub && ua !== ub) return ua > ub;
            if (ua && !ub) return true;
            if (ub && !ua) return false;
            const ca = String(a.content || ''), cb = String(b.content || '');
            const ids = c => new Set([...(c.workLogs || []), ...(c.entries || [])].map(x => x?.id).filter(Boolean));
            const ia = ids(a), ib = ids(b);
            const bCovers = (cb.length > ca.length && cb.includes(ca.trim())) || (ib.size > ia.size && [...ia].every(x => ib.has(x)));
            const aCovers = (ca.length > cb.length && ca.includes(cb.trim())) || (ia.size > ib.size && [...ib].every(x => ia.has(x)));
            if (bCovers && !aCovers) return false;
            return true;
        },

        // 回傳 { card, status: same | tookA | tookB | merged, conflicts: [欄位名], rescued: bool }
        mergeCard(a, b, labelB, bc) {
            if (app.store.cardSig(a) === app.store.cardSig(b)) return { card: deepClone((a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b), status: 'same', conflicts: [] };
            if (bc) {
                const ha = this.cardHash(a), hb = this.cardHash(b);
                if (hb === bc.h) return { card: deepClone(a), status: 'tookA', conflicts: [] };
                if (ha === bc.h) return { card: deepClone(b), status: 'tookB', conflicts: [] };
            }
            const aWins = bc ? ((Number(a.updatedAt) || 0) >= (Number(b.updatedAt) || 0)) : this.aLooksNewer(a, b);
            const loserLabel = aWins ? labelB : '本機';
            const merged = {};
            const conflicts = [];
            const notes = [];
            const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter(k => k !== 'updatedAt' && !this.LIST_FIELDS.includes(k)));
            keys.forEach(k => {
                const baseHash = bc ? (bc.f?.[k] ?? this.fieldHash(undefined)) : undefined;
                const r = this.pick(a[k], b[k], baseHash, aWins);
                let value = r.value;
                if (r.conflict) {
                    const label = this.TEXT_FIELDS[k] || this.FIELD_LABELS[k] || k;
                    conflicts.push(label);
                    const loser = typeof r.loser === 'string' ? r.loser.trim() : '';
                    const winner = typeof value === 'string' ? value.trim() : '';
                    if (this.TEXT_FIELDS[k] && k !== 'nextAction' && loser && !winner.includes(loser)) {
                        if (this.BLOCK_TEXT.includes(k)) value = `${winner ? winner + '\n\n' : ''}—— 合併時保留的${loserLabel}版本 ——\n${loser}`;
                        else notes.push(`（${loserLabel}版本的${label}）${loser}`);
                    }
                }
                if (value !== undefined) merged[k] = deepClone(value);
            });
            if (notes.length) merged.content = `${String(merged.content || '').trim() ? String(merged.content).trim() + '\n\n' : ''}—— 合併時保留的${loserLabel}版本 ——\n${notes.join('\n')}`;
            this.LIST_FIELDS.forEach(k => {
                const v = this.mergeList(a[k], b[k], bc ? (k === 'workLogs' ? bc.logs : bc.entries) : null, aWins);
                if (v !== undefined) merged[k] = v;
            });
            const sig = app.store.cardSig(merged);
            const status = sig === app.store.cardSig(a) ? 'tookA' : (sig === app.store.cardSig(b) ? 'tookB' : 'merged');
            merged.updatedAt = Math.max(Number(a.updatedAt) || 0, Number(b.updatedAt) || 0) || undefined;
            if (status === 'merged') merged.updatedAt = Date.now();
            if (merged.updatedAt === undefined) delete merged.updatedAt;
            return { card: merged, status, conflicts, rescued: notes.length > 0 || conflicts.some(c => this.BLOCK_TEXT.some(k => this.TEXT_FIELDS[k] === c)) };
        },

        // a = 這邊（通常是本機），b = 另一邊（雲端／備份／另一分頁）；base = 上次同步時的指紋（可為 null）
        mergeDocs(aRaw, bRaw, labelB = '雲端', base = null) {
            const A = app.migrate.normalize(aRaw);
            const B = app.migrate.normalize(bRaw);
            const tA = A.meta.tombstones, tB = B.meta.tombstones;
            const bCards = base?.cards || null, bNodes = base?.nodes || null, bTabs = base?.tabs || null, bMisc = base?.misc || null;
            const report = { onlyA: [], onlyB: [], fromB: [], changed: [], conflicts: [], deletedByA: [], deletedByB: [], keptEdited: [], misc: [], nodes: 0 };
            const title = c => String(c?.title || '').trim() || '（未命名卡片）';

            // --- 卡片 ---
            const index = doc => {
                const map = new Map();
                Object.entries(doc.workspaces).forEach(([tabId, list]) => list.forEach(c => map.set(c.id, { card: c, tabId })));
                return map;
            };
            const mapA = index(A), mapB = index(B);
            const placed = new Map(); // tabId -> cards
            const place = (tabId, card) => { if (!placed.has(tabId)) placed.set(tabId, []); placed.get(tabId).push(card); };
            const handled = new Set();
            const visit = (id) => {
                if (handled.has(id)) return;
                handled.add(id);
                const a = mapA.get(id), b = mapB.get(id);
                const bc = bCards ? bCards[id] : null;
                if (a && b) {
                    const res = this.mergeCard(a.card, b.card, labelB, bc);
                    if (res.conflicts.length) report.conflicts.push(`${title(res.card)}（${res.conflicts.join('、')}）`);
                    else if (res.status === 'tookB') report.fromB.push(title(res.card));
                    else if (res.status === 'merged') report.changed.push(title(res.card));
                    let tabId;
                    if (bc) tabId = a.tabId !== bc.tab ? a.tabId : b.tabId;
                    else tabId = ((Number(b.card.updatedAt) || 0) > (Number(a.card.updatedAt) || 0)) ? b.tabId : a.tabId;
                    place(tabId, res.card);
                } else if (a || b) {
                    const mine = a || b;
                    const otherTomb = a ? tB.cards[id] : tA.cards[id];
                    const edited = bc ? this.cardHash(mine.card) !== bc.h : null;
                    let deleted;
                    if (bc) deleted = !edited;                    // 上次同步時還在、這邊沒改過 → 另一邊刪掉了
                    else deleted = !!(otherTomb && otherTomb >= (Number(mine.card.updatedAt) || 0));
                    if (deleted) (a ? report.deletedByB : report.deletedByA).push(title(mine.card));
                    else {
                        if (bc && edited) report.keptEdited.push(title(mine.card));
                        else (a ? report.onlyA : report.onlyB).push(title(mine.card));
                        place(mine.tabId, deepClone(mine.card));
                    }
                }
            };
            const allTabOrder = [...A.tabs.map(t => t.id), ...B.tabs.map(t => t.id).filter(id => !A.tabs.some(t => t.id === id))];
            allTabOrder.forEach(tid => {
                (A.workspaces[tid] || []).forEach(c => visit(c.id));
                (B.workspaces[tid] || []).forEach(c => visit(c.id));
            });
            mapA.forEach((_, id) => visit(id));
            mapB.forEach((_, id) => visit(id));

            // --- 發想節點 ---
            const nodesPlaced = new Map();
            const placeNode = (tabId, n) => { if (!nodesPlaced.has(tabId)) nodesPlaced.set(tabId, []); nodesPlaced.get(tabId).push(n); };
            const nodeIndex = doc => { const m = new Map(); Object.entries(doc.nodes).forEach(([tabId, list]) => list.forEach(n => m.set(n.id, { n, tabId }))); return m; };
            const nA = nodeIndex(A), nB = nodeIndex(B);
            new Set([...nA.keys(), ...nB.keys()]).forEach(id => {
                const a = nA.get(id), b = nB.get(id);
                const bn = bNodes ? bNodes[id] : null;
                if (a && b) {
                    let pickB;
                    if (app.store.cardSig(a.n) === app.store.cardSig(b.n)) pickB = false;
                    else if (bn && this.cardHash(b.n) === bn.h) pickB = false;
                    else if (bn && this.cardHash(a.n) === bn.h) pickB = true;
                    else pickB = (Number(b.n.updatedAt) || 0) > (Number(a.n.updatedAt) || 0);
                    if (pickB) report.nodes++;
                    const src = pickB ? b : a;
                    placeNode(src.tabId, deepClone(src.n));
                } else {
                    const mine = a || b;
                    let deleted;
                    if (bn) deleted = this.cardHash(mine.n) === bn.h;
                    else { const t = a ? tB.nodes[id] : tA.nodes[id]; deleted = !!(t && t >= (Number(mine.n.updatedAt) || 0)); }
                    if (!deleted) placeNode(mine.tabId, deepClone(mine.n));
                    if ((a && deleted) || (b && !a && !deleted)) report.nodes++;
                }
            });

            // --- 分頁：兩邊都有的保留；只在一邊的，若另一邊刪掉了且裡面已經沒有卡片就移除 ---
            const aMiscNewer = (A.meta.miscUpdatedAt || 0) >= (B.meta.miscUpdatedAt || 0);
            const tabs = [];
            allTabOrder.forEach(tid => {
                const ta = A.tabs.find(t => t.id === tid), tb = B.tabs.find(t => t.id === tid);
                const hasContent = (placed.get(tid) || []).length || (nodesPlaced.get(tid) || []).length;
                if (ta && tb) {
                    const r = this.pick(ta.name, tb.name, bTabs ? bTabs[tid] : undefined, aMiscNewer);
                    if (r.value !== ta.name) report.misc.push(`分頁名稱：${r.value}`);
                    tabs.push({ id: tid, name: r.value });
                    return;
                }
                const t = ta || tb;
                let deleted;
                if (bTabs) deleted = tid in bTabs;
                else deleted = !!(ta ? tB.tabs[tid] : tA.tabs[tid]);
                if (hasContent || !deleted) {
                    tabs.push({ ...t });
                    if (tb && !ta) report.misc.push(`新分頁：${t.name}`);
                } else if (ta) report.misc.push(`${labelB}刪除的分頁：${t.name}`);
            });
            const tabIds = new Set(tabs.map(t => t.id));
            const workspaces = {}, nodesOut = {};
            tabs.forEach(t => { workspaces[t.id] = []; nodesOut[t.id] = []; });
            if (!tabs.length) { tabs.push({ id: 'main', name: '主工作區' }); tabIds.add('main'); workspaces.main = []; nodesOut.main = []; }
            const fallbackTab = tabs[0].id;
            placed.forEach((list, tid) => { (workspaces[tabIds.has(tid) ? tid : fallbackTab]).push(...list); });
            nodesPlaced.forEach((list, tid) => { (nodesOut[tabIds.has(tid) ? tid : fallbackTab]).push(...list); });

            // --- 筆記本／詰棋／死線：逐欄位比對，文字衝突時兩邊都留 ---
            const ma = this.miscFields(A), mb = this.miscFields(B);
            const miscLabels = { template: '筆記本模式', free: '全域筆記', q1: '四象限：重要緊急', q2: '四象限：重要不急', q3: '四象限：緊急不重', q4: '四象限：不重不急', stones: '詰棋盤', deadlineTask: '死線倒數名稱', deadlineDate: '死線倒數日期' };
            const mm = {};
            Object.keys(ma).forEach(k => {
                const r = this.pick(ma[k], mb[k], bMisc ? bMisc[k] : undefined, aMiscNewer);
                let value = r.value;
                if (r.conflict && ['free', 'q1', 'q2', 'q3', 'q4'].includes(k)) {
                    const loser = String(r.loser || '').trim(), winner = String(value || '').trim();
                    if (loser && !winner.includes(loser)) value = `${winner ? winner + '\n\n' : ''}—— 合併時保留的另一版本 ——\n${loser}`;
                }
                if (JSON.stringify(value) !== JSON.stringify(ma[k])) report.misc.push(miscLabels[k]);
                mm[k] = value;
            });

            const tomb = { cards: {}, tabs: {}, nodes: {} };
            ['cards', 'tabs', 'nodes'].forEach(k => {
                [tA[k], tB[k]].forEach(src => Object.entries(src || {}).forEach(([id, ts]) => { tomb[k][id] = Math.max(tomb[k][id] || 0, ts); }));
            });
            Object.values(workspaces).flat().forEach(c => { delete tomb.cards[c.id]; });
            Object.values(nodesOut).flat().forEach(n => { delete tomb.nodes[n.id]; });
            tabs.forEach(t => { delete tomb.tabs[t.id]; });

            const doc = {
                tabs, workspaces, nodes: nodesOut,
                globalNotebook: { template: mm.template === 'matrix' ? 'matrix' : 'free', free: mm.free ?? '', matrix: { q1: mm.q1 ?? '', q2: mm.q2 ?? '', q3: mm.q3 ?? '', q4: mm.q4 ?? '' } },
                tsumego: { stones: mm.stones || [] },
                sandbox: { deadlineTask: mm.deadlineTask ?? '', deadlineDate: mm.deadlineDate ?? '' },
                meta: { ...A.meta, tombstones: tomb, miscUpdatedAt: Math.max(A.meta.miscUpdatedAt || 0, B.meta.miscUpdatedAt || 0), updatedAt: Math.max(A.meta.updatedAt || 0, B.meta.updatedAt || 0) }
            };
            return { doc, report };
        },

        reportHtml(r, labelA = '本機', labelB = '雲端') {
            const esc = s => app.entries.escapeHtml(s);
            const block = (icon, text, list) => list.length
                ? `<div class="diff-block"><div class="diff-head">${icon} ${text} <b>${list.length}</b></div><div class="diff-list">${list.slice(0, 10).map(t => `<span>${esc(t)}</span>`).join('')}${list.length > 10 ? `<span class="diff-more">…另有 ${list.length - 10} 項</span>` : ''}</div></div>`
                : '';
            const html = [
                block('☁️', `${labelB}新增的卡片（會加進來）`, r.onlyB),
                block('🔄', `${labelB}改過、${labelA}沒動的卡片（會更新成${labelB}版本）`, r.fromB),
                block('✏️', `兩邊改了不同的地方（自動合在一起）`, r.changed),
                block('⚠️', `同一欄位兩邊不一樣（保留較新的；文字類的另一版本會附在後面，其他欄位請自己確認）`, r.conflicts),
                block('🗑️', `${labelB}已刪除（合併後移除）`, r.deletedByB),
                block('🖥️', `只在${labelA}的卡片（會保留）`, r.onlyA),
                block('🗑️', `${labelA}已刪除（合併後不會再出現）`, r.deletedByA),
                block('🧷', `一邊刪除、另一邊卻修改過（保留下來，請自己判斷）`, r.keptEdited),
                block('📝', `其他資料有變動`, r.misc),
                r.nodes ? `<div class="diff-block"><div class="diff-head">💡 發想棋盤有 <b>${r.nodes}</b> 個節點來自${esc(labelB)}或被${esc(labelB)}刪除</div></div>` : ''
            ].join('');
            return html || `<p>內容一致。</p>`;
        }
    },

    // ==========================================
    // ☁️ 雲端（手動存／載，但有防呆）
    // ==========================================
    cloud: {
        remoteInfo: null,
        busy: false,

        docRef() { return db.collection('Whiteboard_Data').doc(app.currentUser.uid); },

        // 雲端版本 = 伺服器寫入時間。舊版白板用 merge 寫入時也會更新它，所以一定看得到。
        versionOf(data) {
            if (!data) return 0;
            if (data.updatedAt?.toMillis) return data.updatedAt.toMillis();
            return Number(data.clientUpdatedAt) || 0;
        },

        timeOf(data) {
            const ms = this.versionOf(data);
            return ms ? app.ui.fmtTime(ms) : '未知時間';
        },

        toLocalShape(data) {
            return {
                tabs: data.tabs, workspaces: data.workspaces, nodes: data.nodes,
                globalNotebook: data.globalNotebook, tsumego: data.tsumego || { stones: [] },
                sandbox: data.sandbox || {}, meta: data.meta || {}
            };
        },

        hasUnsynced() {
            if (!app.currentUser) return false;
            const i = app.store.syncInfo();
            return i.rev !== i.syncedRev || app.store.pending;
        },

        deviceLabel() {
            const ua = navigator.userAgent || '';
            const os = /iPhone|iPad/.test(ua) ? 'iOS' : (/Android/.test(ua) ? 'Android' : (/Mac/.test(ua) ? 'Mac' : (/Windows/.test(ua) ? 'Windows' : '其他')));
            const br = /Edg\//.test(ua) ? 'Edge' : (/Chrome\//.test(ua) ? 'Chrome' : (/Safari\//.test(ua) ? 'Safari' : (/Firefox\//.test(ua) ? 'Firefox' : '瀏覽器')));
            return `${os} · ${br}`;
        },

        async fetch() {
            const doc = await this.docRef().get();
            return doc.exists ? doc.data() : null;
        },

        setBusy(which, busy) {
            this.busy = busy;
            const btn = document.querySelector(which === 'save' ? '.btn-cloud-save' : '.btn-cloud-load');
            if (!btn) return;
            if (busy) { btn.dataset.label = btn.innerHTML; btn.innerHTML = which === 'save' ? '上傳中…' : '下載中…'; btn.disabled = true; }
            else { if (btn.dataset.label) btn.innerHTML = btn.dataset.label; btn.disabled = false; }
        },

        errorDialog(title, err) {
            console.error(err);
            return app.ui.dialog({ title, html: `<p>${app.entries.escapeHtml(err?.message || String(err))}</p><p>本機資料沒有受影響。</p>`, buttons: [{ label: '知道了', value: true, primary: true }] });
        },

        async save() {
            if (this.busy) return;
            this.setBusy('save', true);
            try {
                if (!app.store.flush(true)) { await app.ui.dialog({ title: '本機儲存失敗，先不上傳', html: '<p>本機目前無法寫入（可能是空間已滿）。請先到「🗂 資料」匯出完整備份。</p>' }); return; }
                let asked = false;
                for (let attempt = 0; attempt < 3; attempt++) {
                    const remote = await this.fetch();
                    const rv = this.versionOf(remote);
                    const info = app.store.syncInfo();
                    if (remote && rv !== info.cloudVersion) {
                        // 雲端在這台裝置上次同步之後被改過：一定先合併，上傳的是合併結果。
                        const remoteDoc = this.toLocalShape(remote);
                        const base = app.sync.loadBase();
                        let { doc: merged, report } = app.sync.mergeDocs(app.store.serialize(), remoteDoc, '雲端', base);
                        let choice = 'merge';
                        const needsAsk = !app.sync.sameContent(merged, app.store.serialize()) || report.conflicts.length;
                        if (needsAsk && !asked) {
                            asked = true;
                            choice = await app.ui.dialog({
                                title: base ? '雲端有其他裝置的新內容' : '第一次同步：本機和雲端有差異',
                                html: `<p>雲端版本：<b>${this.timeOf(remote)}</b>${remote.savedFrom ? `（${app.entries.escapeHtml(remote.savedFrom)}）` : ''}。直接上傳會蓋掉這些內容，建議先合併：</p>${app.sync.reportHtml(report, '本機', '雲端')}`,
                                wide: true,
                                buttons: [
                                    { label: '取消', value: null },
                                    { label: '用本機覆蓋雲端', value: 'overwrite', danger: true },
                                    { label: '合併後上傳（建議）', value: 'merge', primary: true }
                                ]
                            });
                            if (!choice) return;
                            if (choice === 'overwrite') asked = false; // 若要重試，覆蓋前會再問一次
                        }
                        if (choice === 'merge' && needsAsk) {
                            // 對話框開著的期間可能又有修改（計時停止、另一分頁），用「現在」的資料重新合併。
                            app.store.flush(true);
                            ({ doc: merged } = app.sync.mergeDocs(app.store.serialize(), remoteDoc, '雲端', base));
                            await app.backup.save('合併前的本機版本', app.store.serialize());
                            if (!app.store.applyAndSave(merged, {})) throw new Error('合併結果無法寫入本機');
                            app.rerender();
                        }
                    }
                    app.store.flush(true);
                    const revAtUpload = app.store.syncInfo().rev;
                    const doc = app.store.serialize();
                    const result = await this.upload(doc, rv, remote);
                    if (result === 'retry') continue;
                    if (!result) return;
                    if (result.foreign) {
                        // 上傳成功，但緊接著有別台裝置寫入：不把雲端當成和本機一致，下次存／載會先比對。
                        app.store.setSyncInfo({ cloudSavedAt: Date.now() });
                        app.ui.toast('已上傳，但雲端剛好也被另一台裝置更新；之後存／載時會先比對合併。', 'warn', 6000);
                        return;
                    }
                    app.store.setSyncInfo({ syncedRev: revAtUpload, cloudVersion: result.version, cloudSavedAt: Date.now() });
                    app.sync.saveBase(doc);
                    this.remoteInfo = { version: result.version, at: result.version, from: this.deviceLabel() };
                    app.ui.clearBanner('cloud');
                    app.ui.toast(`☁️ 已上傳到雲端（${Math.round(result.size / 1024)} KB）`);
                    if (result.size > CLOUD_DOC_SOFT_LIMIT) {
                        app.ui.banner('warn', `雲端資料已用掉約 ${Math.round(result.size / CLOUD_DOC_HARD_LIMIT * 100)}%（${Math.round(result.size / 1024)} KB / 約 1 MB）。可到「🗂 資料」看看哪些舊資料可以整理。`, [], 'size');
                    }
                    return;
                }
                app.ui.toast('雲端剛好也在被其他裝置更新，這次沒有上傳。請稍後再按一次。', 'warn', 6000);
            } catch (err) {
                this.errorDialog('上傳失敗', err);
            } finally {
                this.setBusy('save', false);
                app.ui.renderSyncStatus();
            }
        },

        // 回傳 { version, size }；雲端在這段期間又變了就回傳 'retry'；太大或失敗回傳 null。
        async upload(doc, expectedVersion, previousRemote) {
            const writeId = app.makeId('write');
            const body = JSON.parse(JSON.stringify({ ...doc, schema: SCHEMA_VERSION, appVersion: APP_VERSION, clientUpdatedAt: Date.now(), savedFrom: this.deviceLabel(), writeId }));
            const size = app.store.sizeOf(body);
            if (size > CLOUD_DOC_HARD_LIMIT) {
                await app.ui.dialog({
                    title: '資料太大，這次沒有上傳',
                    html: `<p>目前資料約 <b>${Math.round(size / 1024)} KB</b>，超過雲端單一文件的上限（約 1 MB）。本機資料完整，沒有遺失。</p><p>請先到「🗂 資料」匯出完整備份檔，再整理不需要的舊卡片或工作紀錄。</p>`,
                    buttons: [{ label: '打開「資料」', value: true, primary: true }]
                });
                app.dataCenter.open();
                return null;
            }
            // 寫入前再確認一次雲端沒有在這段時間被別台裝置改掉。
            const latest = await this.fetch();
            if (this.versionOf(latest) !== expectedVersion) return 'retry';
            if (latest || previousRemote) await app.backup.save('上傳前的雲端版本', this.toLocalShape(latest || previousRemote));
            // 不用 merge:true —— 這樣在本機刪掉的分頁／卡片，雲端才會真的跟著消失。
            await this.docRef().set({ ...body, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
            const after = await this.fetch();
            // 讀回來的不是自己剛寫的（別台裝置剛好也寫入）：不記這個版本，下次存雲端會強制先合併。
            if (after?.writeId !== writeId) return { version: expectedVersion, size, foreign: true };
            return { version: this.versionOf(after), size };
        },

        async load() {
            if (this.busy) return;
            this.setBusy('load', true);
            try {
                app.store.flush(true);
                const remote = await this.fetch();
                if (!remote) { app.ui.toast('雲端目前沒有備份資料'); return; }
                const remoteDoc = this.toLocalShape(remote);
                const rv = this.versionOf(remote);
                const info = app.store.syncInfo();
                const base = app.sync.loadBase();
                const unsynced = this.hasUnsynced();

                if (!unsynced && base && rv === info.cloudVersion) { app.ui.toast('本機已經是最新的雲端版本'); app.ui.clearBanner('cloud'); return; }
                await app.backup.save('載入雲端前的本機版本', app.store.serialize());

                if (!unsynced && base) {
                    // 這台裝置上次同步後沒有改過任何東西 → 直接用雲端版本。
                    if (app.store.applyAndSave(remoteDoc, { cloudVersion: rv, synced: true })) app.sync.saveBase(remoteDoc);
                    app.rerender();
                    app.ui.clearBanner('cloud');
                    app.ui.toast(`📥 已載入雲端版本（${this.timeOf(remote)}）`);
                    return;
                }

                // 這台裝置有沒上傳的修改，或是第一次同步（沒有比對基準）：一律先比對。
                let { doc: merged, report } = app.sync.mergeDocs(app.store.serialize(), remoteDoc, '雲端', base);
                if (app.sync.sameContent(merged, remoteDoc) && !report.conflicts.length) {
                    if (app.store.applyAndSave(remoteDoc, { cloudVersion: rv, synced: true })) app.sync.saveBase(remoteDoc);
                    app.rerender();
                    app.ui.clearBanner('cloud');
                    app.ui.toast(`📥 已載入雲端版本（${this.timeOf(remote)}）`);
                    return;
                }
                if (app.sync.sameContent(merged, app.store.serialize()) && !report.conflicts.length) {
                    app.store.setSyncInfo({ cloudVersion: rv });
                    app.sync.saveBase(remoteDoc);
                    app.ui.clearBanner('cloud');
                    app.ui.toast('雲端沒有新的內容；這台裝置的修改還沒上傳，記得按「☁️ 存雲端」。', 'info', 5000);
                    return;
                }
                const choice = await app.ui.dialog({
                    title: base ? '這台裝置有還沒上傳的修改' : '第一次同步：本機和雲端有差異',
                    html: `<p>雲端版本：<b>${this.timeOf(remote)}</b>${remote.savedFrom ? `（${app.entries.escapeHtml(remote.savedFrom)}）` : ''}。直接載入會蓋掉本機的內容，建議合併（兩邊都保留）：</p>${app.sync.reportHtml(report, '本機', '雲端')}`,
                    wide: true,
                    buttons: [
                        { label: '取消', value: null },
                        { label: '用雲端覆蓋本機', value: 'overwrite', danger: true },
                        { label: '合併（建議）', value: 'merge', primary: true }
                    ]
                });
                if (!choice) return;
                if (choice === 'merge') {
                    app.store.flush(true);
                    ({ doc: merged } = app.sync.mergeDocs(app.store.serialize(), remoteDoc, '雲端', base));
                    if (app.store.applyAndSave(merged, { cloudVersion: rv })) app.sync.saveBase(remoteDoc);
                    app.ui.toast('已合併。合併結果還沒上傳，確認沒問題後按「☁️ 存雲端」。', 'warn', 6000);
                } else {
                    if (app.store.applyAndSave(remoteDoc, { cloudVersion: rv, synced: true })) app.sync.saveBase(remoteDoc);
                    app.ui.toast('📥 已用雲端版本覆蓋本機（覆蓋前的本機版本在「🗂 資料 → 版本備份」）', 'info', 6000);
                }
                app.ui.clearBanner('cloud');
                app.rerender();
            } catch (err) {
                this.errorDialog('下載失敗', err);
            } finally {
                this.setBusy('load', false);
                app.ui.renderSyncStatus();
            }
        },

        async checkOnStartup(hadLocal) {
            const revAtStart = app.store.syncInfo().rev;
            try {
                const remote = await this.fetch();
                if (!remote) { this.remoteInfo = null; app.ui.renderSyncStatus(); return; }
                const version = this.versionOf(remote);
                this.remoteInfo = { version, at: version, from: remote.savedFrom || '' };
                const info = app.store.syncInfo();
                const untouched = info.rev === revAtStart && !app.store.pending;
                if (!hadLocal && untouched && app.sync.sameContent(app.store.serialize(), {})) {
                    if (app.store.applyAndSave(this.toLocalShape(remote), { cloudVersion: version, synced: true })) app.sync.saveBase(this.toLocalShape(remote));
                    app.rerender();
                    app.ui.toast(`這台裝置沒有本機資料，已自動載入雲端版本（${this.timeOf(remote)}）`, 'info', 5000);
                } else if (version && version !== info.cloudVersion) {
                    const msg = info.cloudVersion
                        ? `雲端有其他裝置上傳的較新版本（${this.timeOf(remote)}${remote.savedFrom ? '，' + remote.savedFrom : ''}）。`
                        : `新版同步第一次使用：雲端備份是 ${this.timeOf(remote)}。建議按「比對並載入」，系統會先列出差異再合併，不會直接覆蓋。`;
                    app.ui.banner('info', msg, [{ label: '比對並載入', action: () => this.load() }], 'cloud');
                }
            } catch (err) {
                console.warn('無法檢查雲端版本', err);
            }
            app.ui.renderSyncStatus();
        },

        lastQuietCheck: 0,
        async quietCheck() {
            if (!app.currentUser || this.busy || Date.now() - this.lastQuietCheck < 10 * 60 * 1000) return;
            this.lastQuietCheck = Date.now();
            try {
                const remote = await this.fetch();
                if (!remote) return;
                const version = this.versionOf(remote);
                this.remoteInfo = { version, at: version, from: remote.savedFrom || '' };
                const info = app.store.syncInfo();
                if (version && info.cloudVersion && version !== info.cloudVersion) {
                    app.ui.banner('info', `雲端有其他裝置上傳的較新版本（${this.timeOf(remote)}）。`, [{ label: '比對並載入', action: () => this.load() }], 'cloud');
                }
                app.ui.renderSyncStatus();
            } catch (err) { console.warn(err); }
        }
    },

    // ==========================================
    // 🗂 本機版本備份（IndexedDB，只在這台裝置）
    // ==========================================
    backup: {
        dbPromise: null,
        MAX_SNAPSHOTS: 30,
        MAX_TRASH: 300,

        open() {
            if (this.dbPromise) return this.dbPromise;
            this.dbPromise = new Promise((resolve, reject) => {
                if (!('indexedDB' in window)) return reject(new Error('此瀏覽器不支援 IndexedDB'));
                const req = indexedDB.open('whiteboard_backups', 1);
                req.onupgradeneeded = () => {
                    const d = req.result;
                    if (!d.objectStoreNames.contains('snapshots')) d.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true }).createIndex('uid', 'uid');
                    if (!d.objectStoreNames.contains('trash')) d.createObjectStore('trash', { keyPath: 'id', autoIncrement: true }).createIndex('uid', 'uid');
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            this.dbPromise.catch(() => { this.dbPromise = null; });
            return this.dbPromise;
        },

        async run(storeName, mode, fn) {
            const d = await this.open();
            return new Promise((resolve, reject) => {
                const tx = d.transaction(storeName, mode);
                const store = tx.objectStore(storeName);
                let result;
                Promise.resolve(fn(store)).then(r => { result = r; });
                tx.oncomplete = () => resolve(result);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        },

        reqP(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); },

        async list(storeName = 'snapshots') {
            try {
                const uid = app.currentUser?.uid;
                const d = await this.open();
                const rows = await this.reqP(d.transaction(storeName).objectStore(storeName).index('uid').getAll(uid));
                return rows.sort((a, b) => b.at - a.at);
            } catch (err) { console.warn(err); return []; }
        },

        async get(storeName, id) {
            try { const d = await this.open(); return await this.reqP(d.transaction(storeName).objectStore(storeName).get(id)); }
            catch { return null; }
        },

        async remove(storeName, id) {
            try { await this.run(storeName, 'readwrite', s => { s.delete(id); }); } catch (err) { console.warn(err); }
        },

        async prune(storeName, max, label = null) {
            const all = await this.list(storeName);
            // 每日備份與其他備份分開計算，存雲端很頻繁時也不會把每日備份擠掉。
            const rows = label === null ? all : all.filter(r => (r.label === '每日自動備份') === (label === '每日自動備份'));
            const extra = rows.slice(max);
            if (extra.length) await this.run(storeName, 'readwrite', s => { extra.forEach(r => s.delete(r.id)); });
        },

        async save(label, data) {
            try {
                if (!app.currentUser) return;
                const json = typeof data === 'string' ? data : JSON.stringify(data);
                await this.run('snapshots', 'readwrite', s => { s.add({ uid: app.currentUser.uid, label, at: Date.now(), size: json.length, json }); });
                await this.prune('snapshots', label === '每日自動備份' ? 14 : this.MAX_SNAPSHOTS, label);
                return true;
            } catch (err) { console.warn('版本備份失敗（不影響主要資料）', err); return false; }
        },

        // 放進「最近刪除」；存不進去時先問，不默默刪掉。回傳是否可以繼續刪除。
        async trashOrConfirm(items, reason = '刪除') {
            if (await this.trashCards(items, reason)) return true;
            return await app.ui.confirm('無法保存到「最近刪除」',
                '<p>這個瀏覽器目前無法保存刪除紀錄（可能是無痕模式或空間不足），刪除後<b>無法從「最近刪除」救回</b>。</p><p>仍要刪除嗎？（雲端上次的版本仍在，可以從雲端取回）</p>', '仍要刪除', true);
        },

        async trashCards(items, reason = '刪除') {
            try {
                if (!app.currentUser || !items.length) return true;
                const at = Date.now();
                await this.run('trash', 'readwrite', s => {
                    items.forEach(({ card, tabId }) => s.add({ uid: app.currentUser.uid, at, reason, tabId, tabName: app.state.tabs.find(t => t.id === tabId)?.name || '', card: deepClone(card) }));
                });
                await this.prune('trash', this.MAX_TRASH);
                return true;
            } catch (err) { console.warn('最近刪除保存失敗', err); return false; }
        },

        async dailySnapshot() {
            try {
                const key = `whiteboard_lastdaily_${app.currentUser.uid}`;
                const today = app.worktime.localDateString();
                if (localStorage.getItem(key) === today) return;
                await this.save('每日自動備份', app.store.serialize());
                localStorage.setItem(key, today);
            } catch (err) { console.warn(err); }
        }
    },

    rerender() {
        this.renderAll();
        if (this.state.view === 'sandbox') { this.sandbox.refreshActiveNoteUI(); this.sandbox.renderTodo(); }
        this.renderTsumegoStones();
        this.sandbox.syncDeadlineInputs();
        this.ui.renderSyncStatus();
    },

    // ==========================================
    // 🪟 介面小工具：提示、對話框、同步狀態、避免打字中被重繪
    // ==========================================
    ui: {
        pointerDown: false,
        deferred: [],
        idleRenderTimer: null,
        saveState: 'saved',
        saveError: null,

        lastErrorAt: 0,
        reportError(err, where = '') {
            console.error(where, err);
            if (Date.now() - this.lastErrorAt < 4000) return;
            this.lastErrorAt = Date.now();
            const msg = String(err?.message || err || '').slice(0, 120);
            try { this.toast(`⚠️ 畫面發生錯誤${where ? `（${where}）` : ''}：${msg}。資料沒有受影響；如果一直出現，把這段訊息截圖給我。`, 'warn', 8000); } catch {}
        },

        installGlobalHandlers() {
            window.addEventListener('error', e => { if (e?.error || e?.message) app.ui.reportError(e.error || e.message); });
            window.addEventListener('unhandledrejection', e => app.ui.reportError(e?.reason || 'Promise 錯誤'));
            document.addEventListener('pointerdown', () => { this.pointerDown = true; }, true);
            const release = () => {
                if (!this.pointerDown) return;
                this.pointerDown = false;
                // 等這次點擊事件跑完再更新畫面，避免「點了沒反應」。
                setTimeout(() => this.runDeferred(), 0);
            };
            document.addEventListener('pointerup', release, true);
            document.addEventListener('pointercancel', release, true);
            window.addEventListener('storage', e => app.store.onStorage(e));
            window.addEventListener('beforeunload', () => { app.store.flush(); app.sandbox.persistTimer(); });
            window.addEventListener('pagehide', () => { app.store.flush(); app.sandbox.persistTimer(); });
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') { app.store.flush(); app.sandbox.persistTimer(); }
                else if (app.currentUser) { app.sandbox.updateDisplay(); app.cloud.quietCheck(); }
            });
            window.addEventListener('resize', () => {
                if (app.state.view === 'matrix') app.renderMatrix();
                if (app.state.tsumego.isOpen) app.renderTsumegoStones();
            });
        },

        // 在目前這次點擊／輸入事件結束後才執行，並盡量保住游標位置。
        defer(fn) {
            this.deferred.push(fn);
            if (!this.pointerDown) setTimeout(() => this.runDeferred(), 0);
        },
        runDeferred() {
            if (this.pointerDown) return;
            const list = this.deferred.splice(0);
            if (!list.length) return;
            this.withFocus(() => list.forEach(fn => { try { fn(); } catch (err) { console.error(err); } }));
        },

        withFocus(fn) {
            const el = document.activeElement;
            const key = el?.dataset?.fk;
            let selStart = null, selEnd = null;
            try { selStart = el?.selectionStart; selEnd = el?.selectionEnd; } catch {}
            const scrollY = window.scrollY;
            fn();
            if (key) {
                const next = document.querySelector(`[data-fk="${CSS.escape(key)}"]`);
                if (next && next !== el) {
                    next.focus({ preventScroll: true });
                    try { if (selStart !== null && selStart !== undefined) next.setSelectionRange(selStart, selEnd); } catch {}
                }
            }
            if (Math.abs(window.scrollY - scrollY) > 2) window.scrollTo(0, scrollY);
        },

        isEditingInMain() {
            const el = document.activeElement;
            if (!el) return false;
            const editable = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit'].includes(el.type)) || el.isContentEditable;
            return editable && !!el.closest('.main-area');
        },

        // 正在輸入時先不重排（例如改專案名稱後卡片要換群組），等離開輸入框再更新。
        renderWhenIdle() {
            clearTimeout(this.idleRenderTimer);
            const attempt = (tries = 0) => {
                if ((this.isEditingInMain() || this.pointerDown) && tries < 240) {
                    this.idleRenderTimer = setTimeout(() => attempt(tries + 1), 500);
                    return;
                }
                this.withFocus(() => app.renderAll());
            };
            this.idleRenderTimer = setTimeout(() => attempt(0), 50);
        },

        fmtTime(ms) {
            if (!ms) return '';
            const d = new Date(ms);
            const now = new Date();
            const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
            return `${d.getFullYear() !== now.getFullYear() ? d.getFullYear() + '/' : ''}${d.getMonth() + 1}/${d.getDate()} ${hm}`;
        },

        setSaveState(state, err = null) {
            this.saveState = state;
            this.saveError = err;
            this.renderSyncStatus();
            if (state === 'error') {
                const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''));
                this.banner('error', quota
                    ? '⚠️ 本機儲存空間已滿，最新修改「沒有」存進本機！請立刻按「☁️ 存雲端」或到「🗂 資料」匯出備份，再整理舊資料。'
                    : `⚠️ 本機儲存失敗：${err?.message || err}。請先按「☁️ 存雲端」或匯出備份。`, [{ label: '打開資料管理', action: () => app.dataCenter.open() }], 'save-error');
            } else if (state === 'saved') {
                this.clearBanner('save-error');
            }
        },

        renderSyncStatus() {
            const el = document.getElementById('sync-status');
            const saveBtn = document.querySelector('.btn-cloud-save');
            if (!el || !app.currentUser) return;
            const info = app.store.syncInfo();
            const local = this.saveState === 'error' ? '<span class="sync-bad">⚠ 本機未存</span>'
                : (this.saveState === 'saving' ? '<span>💾 儲存中…</span>' : `<span>💾 已存</span>`);
            const unsynced = app.cloud.hasUnsynced();
            const cloudAt = info.cloudVersion || app.cloud.remoteInfo?.at || 0;
            const cloud = cloudAt ? `☁️ ${this.fmtTime(cloudAt)}` : '☁️ 尚未同步';
            el.innerHTML = `<span class="sync-line">${local}<span class="sync-sep">·</span><span>${cloud}</span></span>${unsynced ? '<span class="sync-line sync-warn" title="這台裝置有修改還沒上傳到雲端">● 有修改未上傳</span>' : ''}`;
            if (saveBtn) saveBtn.classList.toggle('has-unsynced', unsynced);
        },

        toast(message, type = 'info', duration = 3200) {
            let root = document.getElementById('toast-root');
            if (!root) { root = document.createElement('div'); root.id = 'toast-root'; document.body.appendChild(root); }
            const el = document.createElement('div');
            el.className = `toast toast-${type}`;
            el.textContent = message;
            root.appendChild(el);
            setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 300); }, duration);
        },

        banner(type, message, actions = [], id = null) {
            let root = document.getElementById('banner-root');
            if (!root) { root = document.createElement('div'); root.id = 'banner-root'; document.body.appendChild(root); }
            if (id) root.querySelector(`[data-banner-id="${id}"]`)?.remove();
            const el = document.createElement('div');
            el.className = `app-banner banner-${type}`;
            if (id) el.dataset.bannerId = id;
            const text = document.createElement('span');
            text.className = 'banner-text';
            text.textContent = message;
            el.appendChild(text);
            actions.forEach(a => {
                const b = document.createElement('button');
                b.className = 'banner-btn';
                b.textContent = a.label;
                b.onclick = () => { el.remove(); a.action(); };
                el.appendChild(b);
            });
            const close = document.createElement('button');
            close.className = 'banner-close';
            close.textContent = '✕';
            close.title = '關閉';
            close.onclick = () => el.remove();
            el.appendChild(close);
            root.appendChild(el);
        },

        clearBanner(id) { document.querySelector(`#banner-root [data-banner-id="${id}"]`)?.remove(); },

        // 取代 confirm()：可放差異清單與多個選項。回傳被點的 value。
        dialog({ title, html, buttons = [{ label: '確定', value: true, primary: true }], wide = false }) {
            return new Promise(resolve => {
                const overlay = document.createElement('div');
                overlay.className = 'app-dialog-overlay';
                const box = document.createElement('div');
                box.className = `app-dialog${wide ? ' wide' : ''}`;
                box.innerHTML = `<div class="app-dialog-title"></div><div class="app-dialog-body">${html || ''}</div><div class="app-dialog-actions"></div>`;
                box.querySelector('.app-dialog-title').textContent = title || '';
                const actions = box.querySelector('.app-dialog-actions');
                const done = value => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
                buttons.forEach(b => {
                    const btn = document.createElement('button');
                    btn.className = `app-dialog-btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`;
                    btn.textContent = b.label;
                    btn.onclick = () => done(b.value);
                    actions.appendChild(btn);
                });
                const cancelValue = buttons.find(b => b.value === null || b.value === false)?.value ?? null;
                const onKey = e => { if (e.key === 'Escape') done(cancelValue); };
                document.addEventListener('keydown', onKey);
                overlay.addEventListener('click', e => { if (e.target === overlay) done(cancelValue); });
                overlay.appendChild(box);
                document.body.appendChild(overlay);
                box.querySelector('.app-dialog-btn.primary')?.focus();
            });
        },

        async confirm(title, html, okLabel = '確定', danger = false) {
            return await this.dialog({ title, html, buttons: [{ label: '取消', value: false }, { label: okLabel, value: true, primary: !danger, danger }] });
        }
    },

    // ==========================================
    // 🗂 資料管理：大小、備份、還原、最近刪除、空白卡
    // ==========================================
    dataCenter: {
        async open() {
            app.store.flush();
            const overlay = document.getElementById('modal-data');
            overlay.style.display = 'flex';
            await this.render();
        },
        close() { document.getElementById('modal-data').style.display = 'none'; },

        blankCards() {
            return app.worktime.allCards().filter(({ card }) => app.sync.isBlankCard(card));
        },

        async render() {
            const esc = s => app.entries.escapeHtml(s);
            const target = document.getElementById('data-render-target');
            const doc = app.store.serialize();
            const size = app.store.sizeOf(doc);
            const pct = Math.min(100, Math.round(size / CLOUD_DOC_HARD_LIMIT * 100));
            const info = app.store.syncInfo();
            const cards = app.worktime.allCards();
            const logs = cards.reduce((n, { card }) => n + (card.workLogs || []).length, 0);
            const entries = cards.reduce((n, { card }) => n + (card.entries || []).length, 0);
            const blanks = this.blankCards();
            const [snaps, trash] = await Promise.all([app.backup.list('snapshots'), app.backup.list('trash')]);

            const snapRows = snaps.length ? snaps.map(s => `<div class="data-row"><span class="data-row-main"><b>${esc(s.label)}</b><small>${esc(app.ui.fmtTime(s.at))} · ${Math.round(s.size / 1024)} KB</small></span><span class="data-row-actions"><button class="worklog-action-btn" onclick="app.dataCenter.downloadSnapshot(${s.id})">下載</button><button class="worklog-action-btn" onclick="app.dataCenter.restoreSnapshot(${s.id})">還原…</button></span></div>`).join('')
                : '<div class="data-empty">還沒有版本備份。每天第一次開啟、以及每次雲端存／載前，都會自動留一份。</div>';
            const trashRows = trash.length ? trash.slice(0, 60).map(t => `<div class="data-row"><span class="data-row-main"><b>${esc(String(t.card?.title || '').trim() || '（未命名卡片）')}</b><small>${esc(app.ui.fmtTime(t.at))} · ${esc(t.reason || '刪除')} · 原分頁：${esc(t.tabName || '')}${(t.card?.workLogs || []).length ? ` · 含 ${t.card.workLogs.length} 筆工時` : ''}</small></span><span class="data-row-actions"><button class="worklog-action-btn" onclick="app.dataCenter.restoreTrash(${t.id})">救回</button></span></div>`).join('')
                : '<div class="data-empty">沒有最近刪除的卡片。</div>';
            const blankRows = blanks.length ? blanks.map(({ card, tabName }) => {
                const t = app.idTime(card.id);
                return `<div class="data-row"><span class="data-row-main"><b>（空白卡片）</b><small>${esc(tabName)} · 建立於 ${t ? esc(app.ui.fmtTime(t)) : '未知'}</small></span><span class="data-row-actions"><button class="worklog-action-btn" onclick="app.dataCenter.jump('${card.id}')">看一下</button></span></div>`;
            }).join('') : '<div class="data-empty">沒有空白卡片。</div>';

            target.innerHTML = `
                <section class="data-section">
                    <h4>目前狀態</h4>
                    <div class="data-stats">
                        <span><b>${cards.length}</b> 張卡片</span><span><b>${logs}</b> 筆工時</span><span><b>${entries}</b> 筆工作紀錄</span>
                    </div>
                    <div class="data-meter"><span style="width:${pct}%" class="${pct > 75 ? 'warn' : ''}"></span></div>
                    <div class="data-note">資料大小約 <b>${Math.round(size / 1024)} KB</b>，雲端單一文件上限約 1 MB（已用 ${pct}%）。</div>
                    <div class="data-note">本機最後修改：${info.lastChangeAt ? esc(app.ui.fmtTime(info.lastChangeAt)) : '—'}　·　這台裝置上次上傳：${info.cloudSavedAt ? esc(app.ui.fmtTime(info.cloudSavedAt)) : '—'}　·　${app.cloud.hasUnsynced() ? '<b style="color:#c2410c">有修改未上傳</b>' : '與雲端一致'}</div>
                </section>
                <section class="data-section">
                    <h4>完整備份檔</h4>
                    <div class="data-note">備份檔是一個 .json，存在你自己的電腦。匯入時會先列出差異，可以選合併或取代。</div>
                    <div class="data-actions">
                        <button class="excel-copy-btn" onclick="app.dataCenter.exportJson()">⬇️ 匯出完整備份</button>
                        <button class="excel-copy-btn" onclick="document.getElementById('data-import-input').click()">⬆️ 匯入備份檔…</button>
                        <input type="file" id="data-import-input" accept=".json,application/json" style="display:none" onchange="app.dataCenter.importJson(this)">
                    </div>
                </section>
                <section class="data-section">
                    <h4>空白卡片 <span class="data-count">${blanks.length}</span></h4>
                    <div class="data-note">沒有標題、內容、工時、工作紀錄的卡片。移除後會先放進「最近刪除」。</div>
                    ${blankRows}
                    ${blanks.length ? `<div class="data-actions"><button class="excel-copy-btn" onclick="app.dataCenter.removeBlanks()">🧹 移除這 ${blanks.length} 張空白卡</button></div>` : ''}
                </section>
                <section class="data-section">
                    <h4>最近刪除 <span class="data-count">${trash.length}</span></h4>
                    <div class="data-note">只存在這台裝置的瀏覽器裡。救回的卡片會放回原工作區（工作區不在了就放第一個工作區）。</div>
                    <div class="data-scroll">${trashRows}</div>
                </section>
                <section class="data-section">
                    <h4>版本備份（自動）<span class="data-count">${snaps.length}</span></h4>
                    <div class="data-note">只存在這台裝置的瀏覽器裡，保留最近 ${app.backup.MAX_SNAPSHOTS} 份。</div>
                    <div class="data-scroll">${snapRows}</div>
                </section>
                <section class="data-section danger-zone">
                    <h4>危險區</h4>
                    <div class="data-note">清除「這台裝置」的白板資料（雲端與版本備份不受影響）。</div>
                    <div class="data-actions"><button class="excel-copy-btn danger" onclick="app.dataCenter.clearLocal()">🧹 清除本機資料</button></div>
                </section>`;
        },

        download(filename, text) {
            const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        },

        exportJson() {
            app.store.flush();
            const stamp = app.worktime.localDateString().replace(/-/g, '');
            const data = { exportedAt: new Date().toISOString(), appVersion: APP_VERSION, ...app.store.serialize() };
            this.download(`白板完整備份_${stamp}.json`, JSON.stringify(data, null, 1));
        },

        async importJson(input) {
            const file = input.files?.[0];
            input.value = '';
            if (!file) return;
            let data;
            try { data = JSON.parse(await file.text()); }
            catch { return app.ui.dialog({ title: '無法讀取', html: '<p>這個檔案不是有效的 JSON 備份檔。</p>' }); }
            await this.mergeOrReplace(data, `備份檔「${file.name}」`);
        },

        async mergeOrReplace(data, label) {
            app.store.flush(true);
            let { doc: merged, report } = app.sync.mergeDocs(app.store.serialize(), data, label, null);
            if (app.sync.sameContent(app.store.serialize(), data)) { app.ui.toast('內容與目前一致，不需要還原'); return; }
            const choice = await app.ui.dialog({
                title: `還原：${label}`,
                html: `<p>和目前資料的差異：</p>${app.sync.reportHtml(report, '目前', label)}`,
                buttons: [
                    { label: '取消', value: null },
                    { label: '完全取代目前資料', value: 'replace', danger: true },
                    { label: '合併（建議）', value: 'merge', primary: true }
                ]
            });
            if (!choice) return;
            await app.backup.save('還原前的本機版本', app.store.serialize());
            app.store.flush(true);
            if (choice === 'merge') {
                ({ doc: merged } = app.sync.mergeDocs(app.store.serialize(), data, label, null));
                app.store.applyAndSave(merged, {});
            } else {
                // 完全取代時，原本的卡片要記成「刪除」，之後同步才不會把它們從雲端帶回來。
                const replaced = app.migrate.normalize(data);
                const now = Date.now();
                const keep = new Set(Object.values(replaced.workspaces).flat().map(c => c.id));
                app.worktime.allCards().forEach(({ card }) => { if (!keep.has(card.id)) replaced.meta.tombstones.cards[card.id] = now; });
                replaced.meta.updatedAt = now;
                app.store.applyAndSave(replaced, {});
            }
            app.rerender();
            app.ui.toast('已還原。記得確認後按「☁️ 存雲端」。', 'info', 5000);
            this.render();
        },

        async downloadSnapshot(id) {
            const snap = await app.backup.get('snapshots', id);
            if (!snap) return;
            const d = new Date(snap.at);
            this.download(`白板版本備份_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.json`, snap.json);
        },

        async restoreSnapshot(id) {
            const snap = await app.backup.get('snapshots', id);
            if (!snap) return;
            let data;
            try { data = JSON.parse(snap.json); } catch { return app.ui.toast('這份備份無法解析，只能下載原始內容', 'warn'); }
            await this.mergeOrReplace(data, `${snap.label}（${app.ui.fmtTime(snap.at)}）`);
        },

        async restoreTrash(id) {
            const item = await app.backup.get('trash', id);
            if (!item?.card) return;
            const card = deepClone(item.card);
            if (app.worktime.getCard(card.id)) card.id = app.makeId('card');
            const tabId = app.state.workspaces[item.tabId] ? item.tabId : app.state.tabs[0].id;
            app.state.workspaces[tabId].push(card);
            delete app.state.meta.tombstones.cards[card.id];
            await app.backup.remove('trash', id);
            app.saveToLocal();
            app.rerender();
            app.ui.toast(`已救回「${String(card.title || '').trim() || '未命名卡片'}」`);
            this.render();
        },

        async removeBlanks() {
            const blanks = this.blankCards();
            if (!blanks.length) return;
            if (!await app.ui.confirm('移除空白卡片', `<p>移除 ${blanks.length} 張完全空白的卡片？之後仍可在「最近刪除」救回。</p>`, '移除')) return;
            if (!await app.backup.trashOrConfirm(blanks.map(({ card, tabId }) => ({ card, tabId })), '清理空白卡')) return;
            const ids = new Set(blanks.map(b => b.card.id));
            Object.keys(app.state.workspaces).forEach(tabId => { app.state.workspaces[tabId] = app.state.workspaces[tabId].filter(c => !ids.has(c.id)); });
            if (ids.has(app.state.sandbox.activeTaskId)) app.state.sandbox.activeTaskId = null;
            app.saveToLocal();
            app.rerender();
            this.render();
        },

        jump(cardId) {
            const row = app.worktime.allCards().find(r => r.card.id === cardId);
            if (!row) return;
            this.close();
            app.actions.jumpToCard(cardId, row.tabId);
        },

        async clearLocal() {
            const unsynced = app.cloud.hasUnsynced();
            if (!await app.ui.confirm('清除本機資料',
                `<p>會清除<b>這台裝置</b>上的白板資料。${unsynced ? '<br><b style="color:#b91c1c">⚠️ 目前有修改還沒上傳到雲端，清除後就只剩版本備份能找回。</b>' : ''}</p><p>清除前會先自動留一份版本備份。</p>`, '清除', true)) return;
            await app.backup.save('清除本機前的版本', app.store.serialize());
            app.sandbox.resetTimerState();
            try { localStorage.removeItem(app.store.key()); } catch {}
            app.sync.clearBase();
            try { localStorage.removeItem(app.store.key('sync')); } catch {}
            app.store.pending = false;
            app.store.apply({});
            app.rerender();
            this.close();
            app.ui.toast('🧹 本機資料已清除，可以按「📥 載雲端」取回雲端版本');
        }
    },

    // ==========================================
    // 📚 卡片工作紀錄（自由標題 + 單筆閱讀）
    // ==========================================
    entries: {
        getCard(cardId) {
            const currentCards = app.state.workspaces[app.state.activeTabId] || [];
            let card = currentCards.find(c => c.id === cardId);
            if (card) return card;
            for (const tabId in app.state.workspaces) {
                card = (app.state.workspaces[tabId] || []).find(c => c.id === cardId);
                if (card) return card;
            }
            return null;
        },

        getList(card) {
            return card && Array.isArray(card.entries) ? card.entries : [];
        },

        getUi(cardId, source = 'timeline') {
            const key = `${source}:${cardId}`;
            if (!app.entryUi[key]) {
                app.entryUi[key] = {
                    mode: 'list',
                    selectedId: null,
                    editingId: null,
                    expanded: app.panelOpen(source, cardId, 'notes')
                };
            }
            return app.entryUi[key];
        },

        escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        },

        formatDate(iso) {
            if (!iso) return '';
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return '';
            const now = new Date();
            const sameYear = d.getFullYear() === now.getFullYear();
            const date = sameYear
                ? `${d.getMonth() + 1}/${d.getDate()}`
                : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
            const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            return `${date} ${time}`;
        },

        getSortedEntries(card) {
            return [...this.getList(card)].sort((a, b) => {
                const aTime = new Date(a.createdAt || 0).getTime() || 0;
                const bTime = new Date(b.createdAt || 0).getTime() || 0;
                return bTime - aTime;
            });
        },

        renderCardPanel(card, source = 'timeline') {
            const compactClass = source === 'kanban' ? ' worklog-compact' : '';
            return `<div class="worklog-panel${compactClass}" id="worklog-panel-${source}-${card.id}">${this.renderPanelInner(card, source)}</div>`;
        },

        renderPanelInner(card, source = 'timeline') {
            const entries = this.getSortedEntries(card);
            const ui = this.getUi(card.id, source);

            if (!ui.expanded) {
                const latest = entries[0];
                return `
                    <div class="worklog-collapsed" onclick="app.entries.toggleExpanded('${card.id}', '${source}')">
                        <div class="worklog-collapsed-main">
                            <span style="font-size:0.84rem;font-weight:bold;color:#475569;">📚 工作紀錄</span>
                            <span class="worklog-count">${entries.length}</span>
                            <span class="worklog-collapsed-latest">${latest ? this.escapeHtml(latest.title || '未命名紀錄') : '尚無紀錄'}</span>
                        </div>
                        <span style="color:#64748b;font-size:0.8rem;">展開 ▾</span>
                    </div>`;
            }

            if (ui.mode === 'new' || ui.mode === 'edit') {
                const editing = ui.mode === 'edit' ? entries.find(e => e.id === ui.editingId) : null;
                const title = editing ? editing.title || '' : '';
                const content = editing ? editing.content || '' : '';
                return `
                    <div class="worklog-header">
                        <div class="worklog-heading">${ui.mode === 'new' ? '＋ 新增工作紀錄' : '✏️ 修改工作紀錄'}</div>
                        <button class="worklog-action-btn" onclick="app.entries.toggleExpanded('${card.id}', '${source}')">收合</button>
                    </div>
                    <div class="worklog-form">
                        <input id="worklog-title-${source}-${card.id}" class="worklog-title-input" type="text" value="${this.escapeHtml(title)}" placeholder="隨意取一個之後找得到的標題">
                        <textarea id="worklog-content-${source}-${card.id}" class="worklog-content-input" placeholder="這裡可以放進度、想法、問題、決定、待確認事項……">${this.escapeHtml(content)}</textarea>
                    </div>
                    <div class="worklog-actions">
                        <button class="worklog-action-btn" onclick="app.entries.cancelEdit('${card.id}', '${source}')">取消</button>
                        <button class="worklog-action-btn" style="color:#4338ca;border-color:#c7d2fe;" onclick="app.entries.save('${card.id}', '${source}', ${editing ? `'${editing.id}'` : 'null'})">儲存</button>
                    </div>`;
            }

            if (ui.mode === 'detail' && ui.selectedId) {
                const entry = entries.find(e => e.id === ui.selectedId);
                if (!entry) {
                    ui.mode = 'list';
                    ui.selectedId = null;
                    return this.renderPanelInner(card, source);
                }
                const created = this.formatDate(entry.createdAt);
                const updated = this.formatDate(entry.updatedAt);
                const updatedText = updated && updated !== created ? `・修改 ${updated}` : '';
                return `
                    <div class="worklog-header">
                        <button class="worklog-back-btn" onclick="app.entries.backToList('${card.id}', '${source}')">← 紀錄列表</button>
                        <div class="worklog-heading" style="justify-content:flex-end;"><button class="worklog-action-btn" onclick="app.entries.toggleExpanded('${card.id}', '${source}')">收合</button></div>
                    </div>
                    <div class="worklog-detail">
                        <div class="worklog-detail-title">${this.escapeHtml(entry.title || '未命名紀錄')}</div>
                        <div class="worklog-detail-content">${this.escapeHtml(entry.content || '').replace(/\n/g, '<br>')}</div>
                        <div class="worklog-detail-meta">建立 ${created}${updatedText}</div>
                    </div>
                    <div class="worklog-actions">
                        <button class="worklog-action-btn" onclick="app.entries.startEdit('${card.id}', '${entry.id}', '${source}')">編輯</button>
                        <button class="worklog-action-btn danger" onclick="app.entries.deleteEntry('${card.id}', '${entry.id}', '${source}')">刪除</button>
                    </div>`;
            }

            const rows = entries.length
                ? entries.map(entry => `
                    <button class="worklog-list-row" onclick="app.entries.openEntry('${card.id}', '${entry.id}', '${source}')">
                        <span class="worklog-list-title">${this.escapeHtml(entry.title || '未命名紀錄')}</span>
                        <span class="worklog-list-date">${this.formatDate(entry.createdAt)}</span>
                    </button>`).join('')
                : `<div class="worklog-empty">尚無工作紀錄。需要留下什麼時再新增即可。</div>`;

            return `
                <div class="worklog-header">
                    <div class="worklog-heading">📚 工作紀錄 <span class="worklog-count">${entries.length}</span></div>
                    <div style="display:flex;gap:6px;align-items:center;">
                        <button class="worklog-add-btn" onclick="app.entries.startNew('${card.id}', '${source}')">＋ 新增</button>
                        <button class="worklog-action-btn" onclick="app.entries.toggleExpanded('${card.id}', '${source}')">收合</button>
                    </div>
                </div>
                <div class="worklog-list">${rows}</div>`;
        },

        refresh(cardId, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card) return;
            if (source === 'sandbox') {
                this.renderSandbox(card);
                return;
            }
            const panel = document.getElementById(`worklog-panel-${source}-${cardId}`);
            if (panel) panel.innerHTML = this.renderPanelInner(card, source);
        },

        renderSandbox(card) {
            const container = document.getElementById('sb-entry-context');
            if (!container) return;
            if (!card) {
                container.style.display = 'none';
                container.innerHTML = '';
                return;
            }
            container.style.display = 'block';
            container.innerHTML = `${app.worktime.renderPlanningPanel(card, 'sandbox')}<div style="height:8px"></div>${app.worktime.renderPanel(card, 'sandbox')}<div style="height:8px"></div><div class="worklog-panel" id="worklog-panel-sandbox-${card.id}">${this.renderPanelInner(card, 'sandbox')}</div>`;
        },

        toggleExpanded(cardId, source = 'sandbox') {
            const ui = this.getUi(cardId, source);
            ui.expanded = !ui.expanded;
            app.setPanelOpen(source, cardId, 'notes', ui.expanded);
            if (!ui.expanded) {
                ui.mode = 'list';
                ui.selectedId = null;
                ui.editingId = null;
            }
            this.refresh(cardId, source);
        },

        startNew(cardId, source = 'timeline') {
            const ui = this.getUi(cardId, source);
            ui.mode = 'new';
            ui.selectedId = null;
            ui.editingId = null;
            ui.expanded = true;
            this.refresh(cardId, source);
            setTimeout(() => document.getElementById(`worklog-title-${source}-${cardId}`)?.focus(), 0);
        },

        openEntry(cardId, entryId, source = 'timeline') {
            const ui = this.getUi(cardId, source);
            ui.mode = 'detail';
            ui.selectedId = entryId;
            ui.editingId = null;
            ui.expanded = true;
            this.refresh(cardId, source);
        },

        backToList(cardId, source = 'timeline') {
            const ui = this.getUi(cardId, source);
            ui.mode = 'list';
            ui.selectedId = null;
            ui.editingId = null;
            this.refresh(cardId, source);
        },

        startEdit(cardId, entryId, source = 'timeline') {
            const ui = this.getUi(cardId, source);
            ui.mode = 'edit';
            ui.editingId = entryId;
            ui.selectedId = entryId;
            this.refresh(cardId, source);
            setTimeout(() => document.getElementById(`worklog-title-${source}-${cardId}`)?.focus(), 0);
        },

        cancelEdit(cardId, source = 'timeline') {
            const ui = this.getUi(cardId, source);
            if (ui.editingId) {
                ui.mode = 'detail';
                ui.selectedId = ui.editingId;
            } else {
                ui.mode = 'list';
                ui.selectedId = null;
            }
            ui.editingId = null;
            this.refresh(cardId, source);
        },

        save(cardId, source = 'timeline', entryId = null) {
            const card = this.getCard(cardId);
            if (!card) return;
            const titleEl = document.getElementById(`worklog-title-${source}-${cardId}`);
            const contentEl = document.getElementById(`worklog-content-${source}-${cardId}`);
            if (!titleEl || !contentEl) return;

            const title = titleEl.value.trim() || '未命名紀錄';
            const content = contentEl.value;
            const now = new Date().toISOString();
            if (!Array.isArray(card.entries)) card.entries = [];

            let savedId = entryId;
            if (entryId) {
                const entry = card.entries.find(e => e.id === entryId);
                if (!entry) return;
                entry.title = title;
                entry.content = content;
                entry.updatedAt = now;
            } else {
                savedId = `entry_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                card.entries.push({
                    id: savedId,
                    title,
                    content,
                    createdAt: now,
                    updatedAt: now
                });
            }

            app.saveToLocal();
            const ui = this.getUi(cardId, source);
            ui.mode = 'detail';
            ui.selectedId = savedId;
            ui.editingId = null;
            this.refresh(cardId, source);
        },

        deleteEntry(cardId, entryId, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card || !Array.isArray(card.entries)) return;
            const entry = card.entries.find(e => e.id === entryId);
            if (!entry) return;
            if (!confirm(`確定刪除工作紀錄「${entry.title || '未命名紀錄'}」？`)) return;

            card.entries = card.entries.filter(e => e.id !== entryId);
            app.saveToLocal();
            const ui = this.getUi(cardId, source);
            ui.mode = 'list';
            ui.selectedId = null;
            ui.editingId = null;
            this.refresh(cardId, source);
        }
    },

    // ==========================================
    // ⏱️ 工項規劃 / 工時紀錄
    // - 舊卡片無新欄位時一律以空值處理，不做 migration。
    // - workLogs 跟著 card 存在既有 workspaces 內，因此既有 Firebase 設定不用改。
    // ==========================================
    worktime: {
        getCard(cardId) { return app.entries.getCard(cardId); },

        getLogs(card) { return card && Array.isArray(card.workLogs) ? card.workLogs : []; },

        localDateString(date = new Date()) {
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        },

        parseLocalDate(value) {
            if (!value) return null;
            const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!m) return null;
            const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
            return Number.isNaN(d.getTime()) ? null : d;
        },

        dateKey(date) { return this.localDateString(date); },

        addDays(date, days) {
            const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            d.setDate(d.getDate() + days);
            return d;
        },

        startOfWeek(date) {
            const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const dow = d.getDay();
            const diff = dow === 0 ? -6 : 1 - dow; // 週一為一週起點
            d.setDate(d.getDate() + diff);
            return d;
        },

        endOfWeek(date) { return this.addDays(this.startOfWeek(date), 6); },

        startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); },

        endOfMonth(date) { return new Date(date.getFullYear(), date.getMonth() + 1, 0); },

        getGanttScale() {
            const raw = app.state.ganttFilters?.scale;
            if (raw === 'day' || raw === 'week' || raw === 'month') return raw;
            return 'week';
        },

        ganttScaleLabel(scale = this.getGanttScale()) {
            return scale === 'month' ? '月' : (scale === 'week' ? '週' : '日');
        },

        buildGanttPeriods(minDate, maxDate, scale = this.getGanttScale()) {
            if (!minDate || !maxDate || minDate > maxDate) return [];
            const periods = [];
            let cursor = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate());
            let guard = 0;
            const maxPeriods = scale === 'day' ? 366 : (scale === 'week' ? 156 : 120);
            while (cursor <= maxDate && guard < maxPeriods) {
                let end;
                if (scale === 'month') end = this.endOfMonth(cursor);
                else if (scale === 'week') end = this.endOfWeek(cursor);
                else end = new Date(cursor);
                if (end > maxDate) end = new Date(maxDate);
                const start = new Date(cursor);
                let label;
                let groupLabel;
                if (scale === 'month') {
                    label = `${start.getMonth()+1}月`;
                    groupLabel = `${start.getFullYear()}`;
                } else if (scale === 'week') {
                    const sameMonth = start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth();
                    label = sameMonth
                        ? `${start.getMonth()+1}/${start.getDate()}–${end.getDate()}`
                        : `${start.getMonth()+1}/${start.getDate()}–${end.getMonth()+1}/${end.getDate()}`;
                    groupLabel = `${start.getFullYear()}/${start.getMonth()+1}`;
                } else {
                    label = String(start.getDate());
                    groupLabel = `${start.getFullYear()}/${start.getMonth()+1}`;
                }
                periods.push({
                    start, end, label, groupLabel,
                    key: `${this.dateKey(start)}_${this.dateKey(end)}`
                });
                cursor = this.addDays(end, 1);
                guard++;
            }
            return periods;
        },

        colorConfig(color) {
            const map = {
                blue:   { hex:'#3b82f6', light:'#dbeafe', label:'一般' },
                green:  { hex:'#10b981', light:'#d1fae5', label:'穩定' },
                red:    { hex:'#ef4444', light:'#fee2e2', label:'關鍵／重要（人工）' },
                yellow: { hex:'#f59e0b', light:'#fef3c7', label:'注意' }
            };
            return map[color] || map.blue;
        },

        logMinutes(log) {
            if (!log) return 0;
            if (Number.isFinite(Number(log.minutes))) return Math.max(0, Number(log.minutes));
            if (Number.isFinite(Number(log.seconds))) return Math.max(0, Number(log.seconds) / 60);
            if (Number.isFinite(Number(log.hours))) return Math.max(0, Number(log.hours) * 60);
            return 0;
        },

        totalMinutes(card) {
            return this.getLogs(card).reduce((sum, log) => sum + this.logMinutes(log), 0);
        },

        dailyMinutesMap(card) {
            const map = {};
            this.getLogs(card).forEach(log => {
                const key = log.workDate || '';
                if (!key) return;
                map[key] = (map[key] || 0) + this.logMinutes(log);
            });
            return map;
        },

        dailyMinutes(card, dateKey) {
            if (!dateKey) return 0;
            return this.getLogs(card).reduce((sum, log) => log.workDate === dateKey ? sum + this.logMinutes(log) : sum, 0);
        },

        dailyLogCount(card, dateKey) {
            return this.getLogs(card).filter(log => log.workDate === dateKey && this.logMinutes(log) > 0).length;
        },

        compactMinutes(totalMinutes = 0) {
            const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
            if (mins <= 0) return '';
            const h = Math.floor(mins / 60);
            const m = mins % 60;
            if (h && !m) return `${h}h`;
            if (h) return `${h}h${m}`;
            return `${m}m`;
        },

        workUsagePercent(card) {
            const planned = this.plannedMinutes(card);
            if (!planned) return null;
            return Math.round((this.totalMinutes(card) / planned) * 100);
        },

        remainingPlannedMinutes(card) {
            const planned = this.plannedMinutes(card);
            if (!planned) return null;
            return Math.round(planned - this.totalMinutes(card));
        },

        totalSeconds(card) { return Math.round(this.totalMinutes(card) * 60); },

        actualHours(card) { return Math.round((this.totalMinutes(card) / 60) * 100) / 100; },

        plannedMinutes(card) {
            if (!card) return 0;
            if (Number.isFinite(Number(card.plannedMinutes))) return Math.max(0, Number(card.plannedMinutes));
            if (Number.isFinite(Number(card.plannedHours))) return Math.max(0, Number(card.plannedHours) * 60);
            return 0;
        },

        plannedParts(card) {
            const total = Math.max(0, Math.round(this.plannedMinutes(card)));
            return { hours: Math.floor(total / 60), minutes: total % 60 };
        },

        formatMinutes(totalMinutes = 0) {
            const mins = Math.max(0, Math.round(Number(totalMinutes) || 0));
            const h = Math.floor(mins / 60);
            const m = mins % 60;
            if (h > 0 && m > 0) return `${h}小時 ${m}分`;
            if (h > 0) return `${h}小時`;
            return `${m}分`;
        },

        formatDuration(totalSeconds = 0) {
            const sec = Math.max(0, Math.round(Number(totalSeconds) || 0));
            if (sec > 0 && sec < 60) return `${sec}秒`;
            return this.formatMinutes(sec / 60);
        },

        statusLabel(status) {
            return ({0:'未開始',1:'進行中',2:'完成',3:'卡住／等待'})[Number(status)] || '未開始';
        },

        progressValue(card, blankWhenUnset = false) {
            const raw = card?.progress;
            if (raw === undefined || raw === null || raw === '') {
                if (Number(card?.status) === 2) return 100;
                return blankWhenUnset ? '' : 0;
            }
            return Math.max(0, Math.min(100, Number(raw) || 0));
        },

        plannedStart(card) {
            return card?.dateMode === 'range' ? (card.dateStart || '') : (card?.dateSingle || '');
        },

        plannedEnd(card) {
            return card?.dateMode === 'range' ? (card.dateEnd || '') : (card?.dateSingle || '');
        },

        derivedActualStart(card) {
            if (card?.actualStart) return card.actualStart;
            const dates = this.getLogs(card).map(l => l.workDate).filter(Boolean).sort();
            return dates[0] || '';
        },

        derivedActualEnd(card) {
            if (card?.actualEnd) return card.actualEnd;
            if (Number(card?.status) !== 2) return '';
            const dates = this.getLogs(card).map(l => l.workDate).filter(Boolean).sort();
            return dates.length ? dates[dates.length - 1] : '';
        },

        ensureActualStart(card, dateStr) {
            if (card && !card.actualStart && dateStr) card.actualStart = dateStr;
        },

        ensureStarted(card, dateStr = this.localDateString()) {
            if (!card) return false;
            let changed = false;
            // 只把「未開始」推進成「進行中」；卡住與完成都尊重使用者原狀態。
            if (Number(card.status || 0) === 0) {
                card.status = 1;
                changed = true;
            }
            if (!card.actualStart && dateStr) {
                card.actualStart = dateStr;
                changed = true;
            }
            return changed;
        },

        markCompleted(card, dateStr = this.localDateString()) {
            if (!card) return;
            card.status = 2;
            card.progress = 100;
            if (!card.actualStart && dateStr) card.actualStart = dateStr;
            if (!card.actualEnd && dateStr) card.actualEnd = dateStr;
        },

        reopenCompleted(card, preferredStatus = null) {
            if (!card || Number(card.status) !== 2) return;
            if (Number(card.progress) >= 100) delete card.progress;
            delete card.actualEnd;
            if (preferredStatus !== null) {
                card.status = Number(preferredStatus);
                return;
            }
            const hasWork = this.totalMinutes(card) > 0 || !!card.actualStart;
            card.status = hasWork ? 1 : 0;
        },

        syncProgressStatus(card) {
            if (!card) return;
            const raw = card.progress;
            if (raw === undefined || raw === null || raw === '') return;
            const progress = Math.max(0, Math.min(100, Number(raw) || 0));
            card.progress = progress;
            if (progress >= 100) {
                this.markCompleted(card);
                return;
            }
            if (Number(card.status) === 2) {
                delete card.actualEnd;
                card.status = (progress > 0 || this.totalMinutes(card) > 0 || !!card.actualStart) ? 1 : 0;
            } else if (progress > 0 && Number(card.status || 0) === 0) {
                this.ensureStarted(card);
            }
        },

        varianceMinutes(card) {
            const planned = this.plannedMinutes(card);
            const actual = this.totalMinutes(card);
            if (!planned) return null;
            return Math.round(actual - planned);
        },

        formatVariance(card) {
            const diff = this.varianceMinutes(card);
            if (diff === null) return '尚未設定預估';
            if (diff === 0) return '與預估相同';
            return `${diff > 0 ? '+' : '-'}${this.formatMinutes(Math.abs(diff))}`;
        },

        getPlanningUi(cardId, source = 'timeline') {
            const key = `${source}:${cardId}`;
            if (!this.planningUi) this.planningUi = {};
            if (!this.planningUi[key]) this.planningUi[key] = { expanded: app.panelOpen(source, cardId, 'plan') };
            return this.planningUi[key];
        },

        togglePlanning(cardId, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card) return;
            const ui = this.getPlanningUi(cardId, source);
            ui.expanded = !ui.expanded;
            app.setPanelOpen(source, cardId, 'plan', ui.expanded);
            this.refresh(cardId, source);
        },

        planSummary(card) {
            const W = this;
            const parts = [];
            const deliverable = String(card.deliverable || '').trim();
            if (deliverable) parts.push(`交付：${deliverable.length > 18 ? deliverable.slice(0, 18) + '…' : deliverable}`);
            const s = W.plannedStart(card), e = W.plannedEnd(card);
            if (!card.isMemo && (s || e)) parts.push(s && e && s !== e ? `${s.slice(5)}～${e.slice(5)}` : (e || s).slice(5));
            const progress = W.progressValue(card, true);
            if (progress !== '') parts.push(`${progress}%`);
            const planned = W.plannedMinutes(card), actual = W.totalMinutes(card);
            if (planned || actual) parts.push(`工時 ${W.formatMinutes(actual)}${planned ? ` / ${W.formatMinutes(planned)}` : ''}`);
            if (String(card.waitingWho || '').trim()) parts.push(`⏳ 等 ${String(card.waitingWho || '').trim()}`);
            const conflicts = card.isMemo ? 0 : W.scheduleConflicts(card).length;
            if (conflicts) parts.push(`⚠ ${conflicts} 個排程重疊`);
            if (!parts.length) parts.push(card.isMemo ? '自由卡・需要時再補' : '尚未填寫・可以請 AI 先填一版');
            return parts.join(' · ');
        },

        renderPlanningPanel(card, source = 'timeline') {
            const esc = app.entries.escapeHtml.bind(app.entries);
            const id = card.id;
            const fk = field => `data-fk="${esc(`${source}:${id}:${field}`)}"`;
            const ui = this.getPlanningUi(id, source);
            const summary = this.planSummary(card);

            if (!ui.expanded) {
                return `
                    <div class="task-meta-panel task-meta-collapsed" id="task-meta-${source}-${id}">
                        <button class="pm-collapse-toggle" type="button" onclick="app.worktime.togglePlanning('${id}','${source}')" aria-expanded="false">
                            <span class="pm-collapse-title">📦 交付與進度</span>
                            <span class="pm-collapse-summary">${esc(summary)}</span>
                            <span class="pm-collapse-icon">展開 ▾</span>
                        </button>
                    </div>`;
            }

            const category = esc(card.category || '');
            const planned = this.plannedParts(card);
            const progress = this.progressValue(card, true);
            const planStart = this.plannedStart(card);
            const planEnd = this.plannedEnd(card);
            const actualStart = this.derivedActualStart(card);
            const actualEnd = this.derivedActualEnd(card);
            const actualMinutes = this.totalMinutes(card);
            const variance = this.varianceMinutes(card);
            const varianceClass = variance === null ? '' : (variance > 0 ? 'variance-positive' : (variance < 0 ? 'variance-negative' : ''));
            const color = card.color || 'blue';
            const colorCfg = this.colorConfig(color);
            const isScheduled = !card.isMemo;
            const excludedFromGantt = !!card.excludeFromGantt;
            const conflicts = isScheduled ? this.scheduleConflicts(card) : [];
            const conflictRows = conflicts.slice(0, 8).map(item => {
                const overlap = item.overlapStart === item.overlapEnd ? item.overlapStart : `${item.overlapStart} → ${item.overlapEnd}`;
                const project = item.card.project?.trim() || '未分類專案';
                return `<button type="button" class="schedule-conflict-item" onclick="app.actions.jumpToCard('${item.card.id}','${item.tabId}')" title="跳到重疊工項"><span class="schedule-conflict-date">${esc(overlap)}</span><span class="schedule-conflict-title">${esc(item.card.title || '未命名')}</span><span class="schedule-conflict-meta">#${esc(project)} · ${esc(item.tabName)}${item.hiddenFromGantt ? ' · 甘特隱藏' : ''}</span></button>`;
            }).join('');
            const conflictPanel = isScheduled && planStart && planEnd && conflicts.length
                ? `<div class="schedule-conflict-panel has-conflict"><div class="schedule-conflict-head">⚠️ 排程重疊：此工項與 ${conflicts.length} 個排程日期有交集（只是提醒）</div><div class="schedule-conflict-list">${conflictRows}</div></div>`
                : '';
            const moreOpen = app.panelOpen(source, id, 'more');
            const waitingSet = String(card.waitingWho || '').trim() || String(card.waitingWhat || '').trim();

            return `
                <div class="task-meta-panel" id="task-meta-${source}-${id}">
                    <button class="pm-collapse-toggle pm-collapse-toggle-open" type="button" onclick="app.worktime.togglePlanning('${id}','${source}')" aria-expanded="true">
                        <span class="pm-collapse-title">📦 交付與進度</span>
                        <span class="pm-collapse-summary">${esc(summary)}</span>
                        <span class="pm-collapse-icon">收合 ▴</span>
                    </button>
                    <div class="pm-section pm-section-plan">
                        <div class="pm-section-body">
                            <div class="pm-ai-row">
                                <span class="pm-hint">不知道怎麼填？讓 AI 依卡片內容先填一版，你再改。全部留白也沒關係。</span>
                                <button type="button" class="worklog-add-btn" onclick="app.coach.open({ template: 'fill', cardId: '${id}' })">🧑‍🏫 請 AI 先填一版</button>
                            </div>
                            <div class="task-meta-grid" style="grid-template-columns:1fr 1fr;">
                                <label class="task-meta-field">
                                    <span class="task-meta-label">要交出什麼 <span class="pm-hint">（交付物：做完別人拿得到的東西）</span></span>
                                    <textarea class="task-meta-textarea" ${fk('deliverable')} placeholder="例如：月報圖表自動插入的可用版本" oninput="app.worktime.editText('${id}','deliverable',this.value,'${source}')">${esc(card.deliverable || '')}</textarea>
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">怎樣算完成 <span class="pm-hint">（誰看了會說 OK）</span></span>
                                    <textarea class="task-meta-textarea" ${fk('acceptance')} placeholder="例如：用 6 月正式資料跑過一次，主管確認格式" oninput="app.worktime.editText('${id}','acceptance',this.value,'${source}')">${esc(card.acceptance || '')}</textarea>
                                </label>
                            </div>
                            <div class="task-meta-grid" style="margin-top:8px;grid-template-columns:1fr 1fr 110px;">
                                <label class="task-meta-field">
                                    <span class="task-meta-label">預計開始</span>
                                    <input class="task-meta-input" ${fk('planStart')} type="date" value="${esc(planStart)}" onchange="app.worktime.updatePlannedDate('${id}','start',this.value,'${source}')">
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">預計完成</span>
                                    <input class="task-meta-input" ${fk('planEnd')} type="date" value="${esc(planEnd)}" onchange="app.worktime.updatePlannedDate('${id}','end',this.value,'${source}')">
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">進度 %</span>
                                    <input class="task-meta-input" ${fk('progress')} type="number" min="0" max="100" step="10" value="${progress}" placeholder="選填" onchange="app.worktime.updateCardField('${id}','progress',this.value,'${source}',true)">
                                </label>
                            </div>
                            <label class="task-meta-field" style="margin-top:8px;">
                                <span class="task-meta-label">➡ 下一步 <span class="pm-hint">（回到這張卡時，從哪裡接）</span></span>
                                <input class="task-meta-input" ${fk('nextStep')} value="${esc(card.nextStep || '')}" placeholder="例如：拿正式資料跑一次，確認圖表定位規則" oninput="app.worktime.editText('${id}','nextStep',this.value,'${source}')">
                            </label>
                            <div class="waiting-box ${waitingSet ? 'active' : ''}">
                                <div class="task-meta-label">⏳ 在等別人？ <span class="pm-hint">（寫清楚等誰、等什麼、哪天要追，週報會自動列出來）</span></div>
                                <div class="task-meta-grid" style="grid-template-columns:1fr 1.6fr 140px auto;margin-top:4px;">
                                    <input class="task-meta-input" ${fk('waitingWho')} value="${esc(card.waitingWho || '')}" placeholder="等誰" oninput="app.worktime.editText('${id}','waitingWho',this.value,'${source}')">
                                    <input class="task-meta-input" ${fk('waitingWhat')} value="${esc(card.waitingWhat || '')}" placeholder="等什麼（例如：確認規格、提供資料）" oninput="app.worktime.editText('${id}','waitingWhat',this.value,'${source}')">
                                    <input class="task-meta-input" ${fk('followUpDate')} type="date" value="${esc(card.followUpDate || '')}" title="哪天要追" onchange="app.worktime.updateCardField('${id}','followUpDate',this.value,'${source}')">
                                    ${waitingSet ? `<button type="button" class="worklog-action-btn" onclick="app.worktime.clearWaiting('${id}','${source}')" title="已收到回覆，清除等待">✓ 收到了</button>` : '<span></span>'}
                                </div>
                            </div>
                            ${conflictPanel}
                        </div>
                    </div>
                    <details class="pm-more" ${moreOpen ? 'open' : ''} ontoggle="app.setPanelOpen('${source}','${id}','more',this.open)">
                        <summary>更多（選填）：卡片用途、分類、標記、預估工時、實際日期、甘特顯示</summary>
                        <div class="pm-section-body">
                            <div class="task-meta-grid">
                                <label class="task-meta-field">
                                    <span class="task-meta-label">卡片用途</span>
                                    <select class="task-meta-input" ${fk('mode')} onchange="app.worktime.updateCardMode('${id}',this.value,'${source}')">
                                        <option value="free" ${!isScheduled ? 'selected' : ''}>自由卡（不進甘特／工項 Excel）</option>
                                        <option value="scheduled" ${isScheduled ? 'selected' : ''}>排程工項</option>
                                    </select>
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">預設工時類別 <span class="pm-hint">（計時／補登時自動帶入）</span></span>
                                    <select class="task-meta-input" ${fk('timeCategory')} onchange="app.worktime.updateCardField('${id}','timeCategory',this.value,'${source}')">${workCategoryOptions(card.timeCategory || '')}</select>
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">任務分類（可留白）</span>
                                    <input class="task-meta-input" ${fk('category')} value="${category}" placeholder="例如：圖表處理" oninput="app.worktime.editText('${id}','category',this.value,'${source}')">
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">標記</span>
                                    <span class="color-select-wrap">
                                        <span class="color-chip" style="background:${colorCfg.hex}"></span>
                                        <select class="task-meta-input" ${fk('color')} onchange="app.worktime.updateCardField('${id}','color',this.value,'${source}')">
                                            <option value="blue" ${color === 'blue' ? 'selected' : ''}>一般</option>
                                            <option value="green" ${color === 'green' ? 'selected' : ''}>穩定</option>
                                            <option value="red" ${color === 'red' ? 'selected' : ''}>關鍵／重要（人工）</option>
                                            <option value="yellow" ${color === 'yellow' ? 'selected' : ''}>注意</option>
                                        </select>
                                    </span>
                                </label>
                            </div>
                            <div class="task-meta-grid" style="margin-top:8px;">
                                <label class="task-meta-field">
                                    <span class="task-meta-label">預估工時（選填）</span>
                                    <span class="duration-grid">
                                        <input class="task-meta-input" ${fk('planH')} type="number" min="0" step="1" value="${planned.hours || ''}" placeholder="小時" onchange="app.worktime.updatePlannedPart('${id}','hours',this.value,'${source}')">
                                        <input class="task-meta-input" ${fk('planM')} type="number" min="0" step="1" value="${planned.minutes || ''}" placeholder="分鐘" onchange="app.worktime.updatePlannedPart('${id}','minutes',this.value,'${source}')">
                                    </span>
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">實際開始</span>
                                    <input class="task-meta-input" ${fk('actualStart')} type="date" value="${esc(actualStart)}" onchange="app.worktime.updateCardField('${id}','actualStart',this.value,'${source}')">
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">實際完成</span>
                                    <input class="task-meta-input" ${fk('actualEnd')} type="date" value="${esc(actualEnd)}" onchange="app.worktime.updateCardField('${id}','actualEnd',this.value,'${source}')">
                                </label>
                            </div>
                            <div class="data-note" style="margin-top:6px;">已投入 ${this.formatMinutes(actualMinutes)} · <span class="${varianceClass}">${this.formatVariance(card)}</span></div>
                            <label class="gantt-visibility-toggle">
                                <input type="checkbox" ${excludedFromGantt ? 'checked' : ''} onchange="app.worktime.updateCardFlag('${id}','excludeFromGantt',this.checked,'${source}')">
                                <span><strong>不要顯示於甘特圖</strong><small>卡片、工時與 Excel 仍保留；正式排程仍會參與重疊提醒。</small></span>
                            </label>
                        </div>
                    </details>
                </div>`;
        },

        clearWaiting(cardId, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card) return;
            const who = String(card.waitingWho || '').trim();
            const what = String(card.waitingWhat || '').trim();
            delete card.waitingWho; delete card.waitingWhat; delete card.followUpDate;
            if (Number(card.status) === 3) card.status = 1;
            // 留一筆紀錄，之後回顧知道等了什麼、何時收到。
            if (who || what) {
                if (!Array.isArray(card.entries)) card.entries = [];
                const now = new Date().toISOString();
                card.entries.push({ id: app.makeId('entry'), title: `收到回覆：${who || '對方'}`, content: what ? `原本在等：${what}` : '', createdAt: now, updatedAt: now });
            }
            app.saveToLocal();
            app.refreshCard(cardId, source);
            app.ui.toast('已清除等待，並在工作紀錄留下一筆');
        },

        logEditing: {},

        renderPanel(card, source = 'timeline') {
            const esc = app.entries.escapeHtml.bind(app.entries);
            const id = card.id;
            const logs = [...this.getLogs(card)].sort((a,b) => {
                const da = `${a.workDate || ''} ${a.createdAt || ''}`;
                const dbb = `${b.workDate || ''} ${b.createdAt || ''}`;
                return dbb.localeCompare(da);
            });
            const total = this.totalMinutes(card);
            const planned = this.plannedMinutes(card);
            const plannedText = planned > 0 ? ` / 預估 ${this.formatMinutes(planned)}` : '';
            const open = app.panelOpen(source, id, 'time');

            if (!open) {
                const last = logs[0];
                return `
                    <div class="worktime-panel worktime-collapsed" id="worktime-panel-${source}-${id}">
                        <button type="button" class="worktime-collapsed-btn" onclick="app.worktime.toggleTimePanel('${id}','${source}')">
                            <span style="font-weight:bold;color:#475569;">⏱️ 工時</span>
                            <span class="worktime-total">實際 ${this.formatMinutes(total)}${plannedText}</span>
                            <span class="worktime-last">${last ? `最近 ${esc(last.workDate || '')}` : '尚無紀錄'}</span>
                            <span class="worktime-open">補登／明細 ▾</span>
                        </button>
                    </div>`;
            }

            const defaultDate = this.localDateString();
            const editingId = this.logEditing[`${source}:${id}`];
            const rows = logs.length ? logs.slice(0, 50).map(log => {
                if (log.id === editingId) {
                    const mins = Math.round(this.logMinutes(log));
                    return `
                    <div class="worktime-row worktime-row-edit">
                        <input id="logedit-date-${source}-${id}" class="worktime-input" type="date" value="${esc(log.workDate || defaultDate)}">
                        <span class="duration-grid">
                            <input id="logedit-h-${source}-${id}" class="worktime-input" type="number" min="0" step="1" value="${Math.floor(mins / 60) || ''}" placeholder="小時">
                            <input id="logedit-m-${source}-${id}" class="worktime-input" type="number" min="0" step="1" value="${mins % 60 || ''}" placeholder="分鐘">
                        </span>
                        <select id="logedit-cat-${source}-${id}" class="worktime-input">${workCategoryOptions(log.category || '')}</select>
                        <input id="logedit-note-${source}-${id}" class="worktime-input" type="text" value="${esc(log.note || '')}" placeholder="工作內容" onkeydown="if(event.key==='Enter') app.worktime.saveLogEdit('${id}','${log.id}','${source}')">
                        <button class="worklog-action-btn" onclick="app.worktime.cancelLogEdit('${id}','${source}')">取消</button>
                        <button class="worklog-action-btn" style="color:#4338ca;border-color:#c7d2fe;" onclick="app.worktime.saveLogEdit('${id}','${log.id}','${source}')">儲存</button>
                    </div>`;
                }
                return `
                <div class="worktime-row">
                    <span>${esc(log.workDate || '')}${this.logTimeRange(log) ? `<br><small style="color:#94a3b8">${esc(this.logTimeRange(log))}</small>` : ''}</span>
                    <strong>${this.formatMinutes(this.logMinutes(log))}</strong>
                    <span class="worktime-row-note" title="${esc(log.note || '')}">${log.category ? `<span class="worktime-cat">${esc(log.category.split(' ')[0])}</span> ` : ''}${esc(log.note || (log.source === 'timer' ? '心流計時' : '手動補登'))} <span class="worktime-source">${log.source === 'timer' ? '· 計時' : '· 手動'}</span></span>
                    <button class="worktime-edit" title="修改此筆工時" onclick="app.worktime.startLogEdit('${id}','${log.id}','${source}')">✏️</button>
                    <button class="worktime-delete" title="刪除此筆工時" onclick="app.worktime.deleteLog('${id}','${log.id}','${source}')">×</button>
                </div>`;
            }).join('') : `<div class="worktime-empty">尚無工時紀錄。按卡片上的 ⏱️ 開始計時，停止後會自動寫入；忘了計時也可以在上面補登。</div>`;
            const more = logs.length > 50 ? `<div class="worktime-empty">只顯示最近 50 筆，完整明細請用甘特圖頁的「複製工時明細」。</div>` : '';

            return `
                <div class="worktime-panel" id="worktime-panel-${source}-${id}">
                    <div class="worktime-header">
                        <span style="font-weight:bold;color:#475569;">⏱️ 工時明細</span>
                        <span style="display:flex;gap:8px;align-items:center;">
                            <span class="worktime-total">實際 ${this.formatMinutes(total)}${plannedText}</span>
                            <button class="worklog-action-btn" onclick="app.worktime.toggleTimePanel('${id}','${source}')">收合</button>
                        </span>
                    </div>
                    <div class="worktime-form">
                        <label class="task-meta-field">
                            <span class="task-meta-label">日期</span>
                            <input id="worktime-date-${source}-${id}" class="worktime-input" type="date" value="${defaultDate}">
                        </label>
                        <label class="task-meta-field">
                            <span class="task-meta-label">開始（選填）</span>
                            <input id="worktime-start-${source}-${id}" class="worktime-input" type="time">
                        </label>
                        <label class="task-meta-field">
                            <span class="task-meta-label">小時</span>
                            <input id="worktime-hours-${source}-${id}" class="worktime-input" type="number" min="0" step="0.25" placeholder="1.5">
                        </label>
                        <label class="task-meta-field">
                            <span class="task-meta-label">分鐘</span>
                            <input id="worktime-minutes-${source}-${id}" class="worktime-input" type="number" min="0" step="1" placeholder="30">
                        </label>
                        <label class="task-meta-field">
                            <span class="task-meta-label">類別</span>
                            <select id="worktime-cat-${source}-${id}" class="worktime-input">${workCategoryOptions(card.timeCategory || '')}</select>
                        </label>
                        <label class="task-meta-field worktime-note-field">
                            <span class="task-meta-label">工作內容</span>
                            <input id="worktime-note-${source}-${id}" class="worktime-input" type="text" placeholder="例如：圖表定位規則測試" onkeydown="if(event.key==='Enter') app.worktime.addManual('${id}','${source}')">
                        </label>
                        <button class="worklog-add-btn" onclick="app.worktime.addManual('${id}','${source}')">＋ 補登</button>
                    </div>
                    <div class="worktime-list">${rows}${more}</div>
                </div>`;
        },

        toggleTimePanel(cardId, source = 'timeline') {
            app.setPanelOpen(source, cardId, 'time', !app.panelOpen(source, cardId, 'time'));
            this.refresh(cardId, source);
        },

        // 面板局部更新：等目前的點擊／輸入結束後才換，不會吃掉下一下點擊。
        refresh(cardId, source = 'timeline') {
            app.ui.defer(() => this.refreshNow(cardId, source));
        },

        refreshNow(cardId, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card) return;
            if (source === 'sandbox') { app.entries.renderSandbox(card); return; }
            const p = document.getElementById(`task-meta-${source}-${cardId}`);
            if (p) p.outerHTML = this.renderPlanningPanel(card, source);
            const w = document.getElementById(`worktime-panel-${source}-${cardId}`);
            if (w) w.outerHTML = this.renderPanel(card, source);
        },

        // 文字欄位：邊打邊存，不重畫畫面（游標不會跳走）。
        editText(cardId, field, value, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card) return;
            card[field] = value;
            if (field === 'nextStep') card.nextAction = value;
            app.saveToLocal();
            const sum = document.querySelector(`#task-meta-${source}-${cardId} .pm-collapse-summary`);
            if (sum) sum.textContent = this.planSummary(card);
            if (field === 'nextStep') app.updateNextStepPreview(cardId);
            if (field === 'waitingWho' || field === 'waitingWhat') app.updateCardBadges(cardId);
        },

        updateCardField(cardId, field, value, source = 'timeline', numeric = false) {
            const card = this.getCard(cardId);
            if (!card) return;
            if (numeric) {
                if (String(value).trim() === '') delete card[field];
                else card[field] = field === 'progress' ? Math.max(0, Math.min(100, Number(value) || 0)) : Number(value);
            } else {
                if (value === '' && (field === 'actualStart' || field === 'actualEnd')) delete card[field];
                else card[field] = value;
            }
            if (field === 'nextStep') card.nextAction = value;
            if (field === 'progress') this.syncProgressStatus(card);
            app.saveToLocal();
            if (['color', 'progress', 'followUpDate'].includes(field)) app.refreshCard(cardId, source);
            else this.refresh(cardId, source);
            if (field === 'progress') app.sandbox.renderTodo();
        },

        updateCardFlag(cardId, field, checked, source = 'timeline') {
            if (field !== 'excludeFromGantt') return;
            const card = this.getCard(cardId);
            if (!card) return;
            card[field] = !!checked;
            app.saveToLocal();
            this.refresh(cardId, source);
        },

        updateCardMode(cardId, mode, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card) return;
            card.isMemo = mode !== 'scheduled';
            if (!card.isMemo && !this.plannedStart(card)) {
                const today = this.localDateString();
                card.dateMode = 'range';
                card.dateStart = today;
                card.dateEnd = today;
            }
            app.saveToLocal();
            app.refreshCard(cardId, source);
        },

        updatePlannedDate(cardId, which, value, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card) return;
            const oldStart = this.plannedStart(card);
            const oldEnd = this.plannedEnd(card);
            card.dateMode = 'range';
            card.dateStart = which === 'start' ? value : oldStart;
            card.dateEnd = which === 'end' ? value : oldEnd;
            if (card.dateStart && !card.dateEnd) card.dateEnd = card.dateStart;
            if (card.dateEnd && !card.dateStart) card.dateStart = card.dateEnd;
            if (card.dateStart && card.dateEnd && card.dateEnd < card.dateStart) {
                if (which === 'start') card.dateEnd = card.dateStart;
                else card.dateStart = card.dateEnd;
            }
            app.saveToLocal();
            app.refreshCard(cardId, source);
        },

        updatePlannedPart(cardId, part, value, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card) return;
            const current = this.plannedParts(card);
            let hours = current.hours;
            let minutes = current.minutes;
            const v = String(value).trim() === '' ? 0 : Math.max(0, Number(value) || 0);
            if (part === 'hours') hours = v;
            else minutes = v;
            const total = Math.round((hours * 60 + minutes) * 100) / 100;
            if (total > 0) card.plannedMinutes = total;
            else delete card.plannedMinutes;
            delete card.plannedHours;
            app.saveToLocal();
            this.refresh(cardId, source);
        },

        addManual(cardId, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card) return;
            const dateEl = document.getElementById(`worktime-date-${source}-${cardId}`);
            const hoursEl = document.getElementById(`worktime-hours-${source}-${cardId}`);
            const minutesEl = document.getElementById(`worktime-minutes-${source}-${cardId}`);
            const noteEl = document.getElementById(`worktime-note-${source}-${cardId}`);
            const hours = Math.max(0, Number(hoursEl?.value) || 0);
            const minutes = Math.max(0, Number(minutesEl?.value) || 0);
            const totalMinutes = Math.round((hours * 60 + minutes) * 100) / 100;
            if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) {
                app.ui.toast('請輸入工時：小時、分鐘擇一填寫即可。', 'warn');
                (hoursEl || minutesEl)?.focus();
                return;
            }
            const workDate = this.parseLocalDate(dateEl?.value) ? dateEl.value : this.localDateString();
            const startTime = (document.getElementById(`worktime-start-${source}-${cardId}`)?.value || '').slice(0, 5);
            if (!Array.isArray(card.workLogs)) card.workLogs = [];
            const now = new Date().toISOString();
            card.workLogs.push({
                id: app.makeId('work'),
                workDate,
                minutes: totalMinutes,
                note: noteEl?.value.trim() || '手動補登',
                source: 'manual', createdAt: now, updatedAt: now,
                ...(/^\d{2}:\d{2}$/.test(startTime) ? { startTime } : {}),
                ...((() => { const c = document.getElementById(`worktime-cat-${source}-${cardId}`)?.value || ''; return c ? { category: c } : {}; })())
            });
            const catSel = document.getElementById(`worktime-cat-${source}-${cardId}`)?.value || '';
            if (catSel && !card.timeCategory) card.timeCategory = catSel; // 第一次選的類別記成這張卡的預設
            this.ensureStarted(card, workDate);
            app.saveToLocal();
            app.refreshCard(cardId, source);
            app.sandbox.renderTodo();
            app.ui.toast(`已補登 ${this.formatMinutes(totalMinutes)}`);
        },

        addTimerLog(cardId, seconds, note = '心流計時', workDate = null, span = null) {
            const card = this.getCard(cardId);
            const sec = Math.round(Number(seconds) || 0);
            if (!card || sec <= 0) return false;
            if (!Array.isArray(card.workLogs)) card.workLogs = [];
            const now = new Date().toISOString();
            const day = workDate || this.localDateString();
            card.workLogs.push({
                id: app.makeId('work'),
                workDate: day,
                minutes: Math.round((sec / 60) * 100) / 100,
                seconds: sec,
                note,
                source: 'timer', createdAt: now, updatedAt: now,
                ...(span ? { startTime: this.clock(span[0]), endTime: this.clock(span[1]) } : {}),
                ...(card.timeCategory ? { category: card.timeCategory } : {})
            });
            this.ensureStarted(card, day);
            app.saveToLocal();
            return true;
        },

        clock(ms) { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; },

        // 這筆工時的時段（有就回傳 'HH:MM–HH:MM'）。舊的計時紀錄用寫入時間往回推。
        logTimeRange(log) {
            if (log.startTime && log.endTime) return `${log.startTime}–${log.endTime}`;
            if (log.startTime) {
                const [h, m] = log.startTime.split(':').map(Number);
                const end = h * 60 + m + Math.round(this.logMinutes(log));
                return end < 24 * 60 ? `${log.startTime}–${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}` : log.startTime;
            }
            if (log.source === 'timer' && log.createdAt) {
                const end = new Date(log.createdAt);
                if (!Number.isNaN(end.getTime()) && this.localDateString(end) === log.workDate) {
                    const start = new Date(end.getTime() - this.logMinutes(log) * 60000);
                    if (this.localDateString(start) === log.workDate) return `${this.clock(start)}–${this.clock(end)}`;
                }
            }
            return '';
        },

        startLogEdit(cardId, logId, source = 'timeline') {
            this.logEditing[`${source}:${cardId}`] = logId;
            this.refresh(cardId, source);
            setTimeout(() => document.getElementById(`logedit-note-${source}-${cardId}`)?.focus(), 30);
        },

        cancelLogEdit(cardId, source = 'timeline') {
            delete this.logEditing[`${source}:${cardId}`];
            this.refresh(cardId, source);
        },

        saveLogEdit(cardId, logId, source = 'timeline') {
            const card = this.getCard(cardId);
            const log = this.getLogs(card).find(l => l.id === logId);
            if (!card || !log) return;
            const date = document.getElementById(`logedit-date-${source}-${cardId}`)?.value || '';
            const h = Math.max(0, Number(document.getElementById(`logedit-h-${source}-${cardId}`)?.value) || 0);
            const m = Math.max(0, Number(document.getElementById(`logedit-m-${source}-${cardId}`)?.value) || 0);
            const note = document.getElementById(`logedit-note-${source}-${cardId}`)?.value || '';
            const cat = document.getElementById(`logedit-cat-${source}-${cardId}`)?.value || '';
            const totalMinutes = Math.round((h * 60 + m) * 100) / 100;
            if (!this.parseLocalDate(date)) { app.ui.toast('日期格式不正確', 'warn'); return; }
            if (totalMinutes <= 0) { app.ui.toast('工時必須大於 0；不要的紀錄請按 × 刪除', 'warn'); return; }
            log.workDate = date;
            log.minutes = totalMinutes;
            delete log.hours;
            delete log.seconds;
            log.note = note.trim() || (log.source === 'timer' ? '心流計時' : '手動補登');
            if (cat) log.category = cat; else delete log.category;
            log.updatedAt = new Date().toISOString();
            this.ensureStarted(card, log.workDate);
            delete this.logEditing[`${source}:${cardId}`];
            app.saveToLocal();
            app.refreshCard(cardId, source);
            app.sandbox.renderTodo();
        },

        async deleteLog(cardId, logId, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card || !Array.isArray(card.workLogs)) return;
            const log = card.workLogs.find(l => l.id === logId);
            if (!log) return;
            if (!await app.ui.confirm('刪除工時紀錄', `<p>刪除 ${app.entries.escapeHtml(log.workDate || '')} 這筆 ${this.formatMinutes(this.logMinutes(log))} 的工時紀錄？</p>`, '刪除', true)) return;
            card.workLogs = card.workLogs.filter(l => l.id !== logId);
            app.saveToLocal();
            app.refreshCard(cardId, source);
            app.sandbox.renderTodo();
        },

        allCards() {
            const rows = [];
            for (const tabId in app.state.workspaces) {
                const tabName = app.state.tabs.find(t => t.id === tabId)?.name || '未知';
                (app.state.workspaces[tabId] || []).forEach(card => rows.push({card, tabId, tabName}));
            }
            return rows;
        },

        scheduledCards() {
            return this.allCards().filter(({card}) => !card.isMemo);
        },

        ganttSourceCards() {
            return this.scheduledCards().filter(({card}) => card.dateMode === 'range' && card.dateStart && card.dateEnd);
        },

        ganttCards() {
            return this.ganttSourceCards().filter(({card}) => !card.excludeFromGantt);
        },

        // 排程重疊：每次資料變動後只算一次（掃描線），不再每張卡各算一輪。
        conflictIndex() {
            const version = app.store.version;
            if (this._conflictCache && this._conflictCache.version === version) return this._conflictCache;
            const rows = this.ganttSourceCards().map(r => ({
                ...r, s: this.parseLocalDate(r.card.dateStart), e: this.parseLocalDate(r.card.dateEnd)
            })).filter(r => r.s && r.e && r.e >= r.s).sort((a, b) => a.s - b.s);
            const map = new Map();
            const add = (owner, other, s, e) => {
                if (!map.has(owner.card.id)) map.set(owner.card.id, []);
                map.get(owner.card.id).push({
                    card: other.card, tabId: other.tabId, tabName: other.tabName,
                    overlapStart: this.dateKey(s), overlapEnd: this.dateKey(e), hiddenFromGantt: !!other.card.excludeFromGantt
                });
            };
            for (let i = 0; i < rows.length; i++) {
                for (let j = i + 1; j < rows.length && rows[j].s <= rows[i].e; j++) {
                    const a = rows[i], b = rows[j];
                    if (a.card.id === b.card.id) continue;
                    const s = new Date(Math.max(a.s, b.s));
                    const e = new Date(Math.min(a.e, b.e));
                    add(a, b, s, e);
                    add(b, a, s, e);
                }
            }
            const sorter = (x, y) => x.overlapStart.localeCompare(y.overlapStart) || String(x.card.title || '').localeCompare(String(y.card.title || ''), 'zh-Hant');
            map.forEach(list => list.sort(sorter));
            this._conflictCache = { version, map, rows, sorter };
            return this._conflictCache;
        },

        scheduleConflicts(card) {
            if (!card || card.isMemo) return [];
            const start = this.parseLocalDate(this.plannedStart(card));
            const end = this.parseLocalDate(this.plannedEnd(card));
            if (!start || !end) return [];
            const idx = this.conflictIndex();
            if (card.dateMode === 'range' && card.dateStart && card.dateEnd) return idx.map.get(card.id) || [];
            // 單日卡片：和所有區間排程比一次。
            return idx.rows.filter(r => r.card.id !== card.id && !(r.e < start || r.s > end)).map(r => ({
                card: r.card, tabId: r.tabId, tabName: r.tabName,
                overlapStart: this.dateKey(new Date(Math.max(start, r.s))), overlapEnd: this.dateKey(new Date(Math.min(end, r.e))),
                hiddenFromGantt: !!r.card.excludeFromGantt
            })).sort(idx.sorter);
        },

        taskExportRows() {
            return this.scheduledCards().map(({card, tabName}) => {
                const planned = this.plannedMinutes(card);
                const actual = this.totalMinutes(card);
                const variance = planned ? Math.round(actual - planned) : '';
                const progress = this.progressValue(card, true);
                return [
                    tabName, card.project||'', card.category||'', card.title||'', this.colorConfig(card.color).label,
                    card.excludeFromGantt ? '否' : '是', this.statusLabel(card.status), progress === '' ? '' : progress,
                    this.plannedStart(card), this.plannedEnd(card), Math.round(planned), planned ? Math.round((planned/60)*100)/100 : '',
                    this.derivedActualStart(card), this.derivedActualEnd(card), Math.round(actual), Math.round((actual/60)*100)/100,
                    variance, card.deliverable||'', card.acceptance||'', card.id||''
                ];
            });
        },

        logExportRows() {
            const rows = [];
            this.allCards().forEach(({card, tabName}) => {
                this.getLogs(card).forEach(log => {
                    const mins = this.logMinutes(log);
                    rows.push([
                        log.workDate || '', tabName, card.project||'', card.category||'', card.title||'',
                        Math.round(mins*100)/100, Math.round((mins/60)*100)/100,
                        log.source === 'timer' ? '心流計時' : '手動補登', log.note||'', card.id||'', log.id||''
                    ]);
                });
            });
            rows.sort((a,b) => String(a[0]).localeCompare(String(b[0])) || String(a[4]).localeCompare(String(b[4])));
            return rows;
        },

        ganttExportRows() {
            return this.ganttSourceCards().map(({card, tabName}) => [
                tabName, card.project||'', card.category||'', card.title||'', this.colorConfig(card.color).label,
                card.excludeFromGantt ? '否' : '是', this.statusLabel(card.status), this.progressValue(card, true), card.dateStart||'', card.dateEnd||'',
                Math.round(this.plannedMinutes(card)), Math.round(this.totalMinutes(card)),
                this.derivedActualStart(card), this.derivedActualEnd(card), card.id||''
            ]);
        },

        tsvCell(value) {
            let v = String(value ?? '').replace(/\r?\n/g, ' ').replace(/\t/g, ' ');
            if (/^[=+@]/.test(v) || /^-\D/.test(v)) v = "'" + v;
            return v;
        },

        copyText(text, successMessage) {
            const fallback = () => {
                const ta = document.createElement('textarea'); ta.value = text;
                ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta);
                ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
                app.ui.toast(successMessage, 'info', 4500);
            };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(() => app.ui.toast(successMessage, 'info', 4500)).catch(fallback);
            } else fallback();
        },

        setGanttFilter(field, value) {
            if (!app.state.ganttFilters) app.state.ganttFilters = { project:'', month:'', mode:'schedule', scale:'' };
            if (field !== 'project' && field !== 'month') return;
            app.state.ganttFilters[field] = value || '';
            app.renderGantt();
        },

        setGanttMode(mode) {
            if (!app.state.ganttFilters) app.state.ganttFilters = { project:'', month:'', mode:'schedule', scale:'' };
            app.state.ganttFilters.mode = mode === 'time' ? 'time' : 'schedule';
            app.rememberPrefs();
            app.renderGantt();
        },

        setGanttScale(scale) {
            if (!app.state.ganttFilters) app.state.ganttFilters = { project:'', month:'', mode:'schedule', scale:'' };
            if (!['day','week','month'].includes(scale)) return;
            app.state.ganttFilters.scale = scale;
            app.rememberPrefs();
            app.renderGantt();
        },

        resetGanttFilters() {
            const mode = app.state.ganttFilters?.mode === 'time' ? 'time' : 'schedule';
            const scale = this.getGanttScale();
            app.state.ganttFilters = { project:'', month:'', mode, scale };
            app.renderGantt();
        },

        copyTasksToExcel() {
            const header = ['分頁','專案','分類','工項','標記','顯示於甘特','狀態','進度(%)','預計開始','預計完成','預估工時(分鐘)','預估工時(小時)','實際開始','實際完成','實際工時(分鐘)','實際工時(小時)','工時差異(分鐘)','預期產出','驗收條件','卡片ID'];
            const rows = this.taskExportRows();
            const tsv = [header, ...rows].map(r => r.map(v => this.tsvCell(v)).join('\t')).join('\n');
            this.copyText(tsv, `已複製 ${rows.length} 筆排程工項，可直接貼到 Excel。自由卡不會列入工項總表。`);
        },

        copyLogsToExcel() {
            const header = ['日期','分頁','專案','分類','工項','工時(分鐘)','工時(小時)','來源','工作內容','卡片ID','工時ID'];
            const rows = this.logExportRows();
            const tsv = [header, ...rows].map(r => r.map(v => this.tsvCell(v)).join('\t')).join('\n');
            this.copyText(tsv, `已複製 ${rows.length} 筆工時明細，可直接貼到 Excel。`);
        },

        copyGanttSourceToExcel() {
            const header = ['分頁','專案','分類','工項','標記','顯示於甘特','狀態','進度(%)','預計開始','預計完成','預估工時(分鐘)','實際工時(分鐘)','實際開始','實際完成','卡片ID'];
            const rows = this.ganttExportRows();
            const tsv = [header, ...rows].map(r => r.map(v => this.tsvCell(v)).join('\t')).join('\n');
            this.copyText(tsv, `已複製 ${rows.length} 筆甘特來源資料，可直接貼到 Excel。`);
        },

        styleExcelHeader(row, fill = '1E293B') {
            row.eachCell(cell => {
                cell.font = { bold:true, color:{argb:'FFFFFFFF'} };
                cell.fill = { type:'pattern', pattern:'solid', fgColor:{argb:`FF${fill}`} };
                cell.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
                cell.border = { bottom:{style:'thin', color:{argb:'FFCBD5E1'}} };
            });
            row.height = 24;
        },

        async exportWorkbookXlsx() {
            if (!window.ExcelJS) return alert('Excel 匯出元件尚未載入。請確認網路後重新整理，再試一次。');
            try {
                const workbook = new ExcelJS.Workbook();
                workbook.creator = '白板 & 心流沙盒';
                workbook.created = new Date();

                // 1) 工項總表
                const taskHeader = ['分頁','專案','分類','工項','標記','顯示於甘特','狀態','進度(%)','預計開始','預計完成','預估工時(分鐘)','預估工時(小時)','實際開始','實際完成','實際工時(分鐘)','實際工時(小時)','工時差異(分鐘)','預期產出','驗收條件','卡片ID'];
                const taskSheet = workbook.addWorksheet('工項總表', { views:[{state:'frozen', ySplit:1}] });
                taskSheet.addRow(taskHeader);
                this.styleExcelHeader(taskSheet.getRow(1));
                this.taskExportRows().forEach(r => {
                    const row = taskSheet.addRow(r);
                    const cardColorLabel = String(r[4] || '');
                    const colorKey = cardColorLabel.startsWith('關鍵') ? 'red' : (cardColorLabel === '注意' ? 'yellow' : (cardColorLabel === '穩定' ? 'green' : 'blue'));
                    const cfg = this.colorConfig(colorKey);
                    row.getCell(4).fill = { type:'pattern', pattern:'solid', fgColor:{argb:`FF${cfg.light.replace('#','').toUpperCase()}`} };
                });
                taskSheet.autoFilter = { from:'A1', to:'T1' };
                [12,16,16,28,18,12,14,10,13,13,16,16,13,13,16,16,18,30,30,26].forEach((w,i)=>taskSheet.getColumn(i+1).width=w);
                taskSheet.eachRow((row, rowNum) => { if (rowNum > 1) row.alignment = { vertical:'top', wrapText:true }; });

                // 2) 工時明細
                const logHeader = ['日期','分頁','專案','分類','工項','工時(分鐘)','工時(小時)','來源','工作內容','卡片ID','工時ID'];
                const logSheet = workbook.addWorksheet('工時明細', { views:[{state:'frozen', ySplit:1}] });
                logSheet.addRow(logHeader);
                this.styleExcelHeader(logSheet.getRow(1));
                this.logExportRows().forEach(r => logSheet.addRow(r));
                logSheet.autoFilter = { from:'A1', to:'K1' };
                [13,12,16,16,28,14,14,14,36,26,26].forEach((w,i)=>logSheet.getColumn(i+1).width=w);
                logSheet.eachRow((row, rowNum) => { if (rowNum > 1) row.alignment = { vertical:'top', wrapText:true }; });

                // 3) 甘特圖：只改視覺尺度，工項總表 / 工時明細仍保留原始日期資料。
                const ganttSheet = workbook.addWorksheet('甘特圖');
                const exportScale = this.getGanttScale();
                const exportScaleLabel = this.ganttScaleLabel(exportScale);
                const entries = this.ganttCards().sort((a,b) => {
                    const ga = `${a.card.project||''}\u0000${a.card.category||''}`;
                    const gb = `${b.card.project||''}\u0000${b.card.category||''}`;
                    return ga.localeCompare(gb) || String(a.card.dateStart).localeCompare(String(b.card.dateStart));
                });
                const leftHeaders = ['工項','專案','分類','狀態','進度','預估 / 實際','預計起迄','實際起迄','分頁','軌道'];
                leftHeaders.forEach((h,i)=>ganttSheet.getCell(2,i+1).value=h);

                let periods = [];
                if (entries.length) {
                    const dateCandidates = [];
                    entries.forEach(({card}) => {
                        const s = this.parseLocalDate(card.dateStart);
                        const e = this.parseLocalDate(card.dateEnd);
                        if (s) dateCandidates.push(s);
                        if (e) dateCandidates.push(e);
                        this.getLogs(card).forEach(log => {
                            const d = this.parseLocalDate(log.workDate);
                            if (d) dateCandidates.push(d);
                        });
                    });
                    if (dateCandidates.length) {
                        let minDate = new Date(Math.min(...dateCandidates.map(d=>d.getTime())));
                        let maxDate = new Date(Math.max(...dateCandidates.map(d=>d.getTime())));
                        if (exportScale === 'week') {
                            minDate = this.startOfWeek(minDate);
                            maxDate = this.endOfWeek(maxDate);
                        } else if (exportScale === 'month') {
                            minDate = this.startOfMonth(minDate);
                            maxDate = this.endOfMonth(maxDate);
                        }
                        periods = this.buildGanttPeriods(minDate, maxDate, exportScale);
                    }
                }

                const periodStartCol = leftHeaders.length + 1;
                periods.forEach((period,idx) => {
                    const col = periodStartCol + idx;
                    ganttSheet.getCell(2,col).value = period.label;
                    ganttSheet.getColumn(col).width = exportScale === 'day' ? 4.2 : (exportScale === 'week' ? 12 : 11);
                });

                if (periods.length) {
                    let groupStart = 0;
                    for (let i=0;i<=periods.length;i++) {
                        const changed = i===periods.length || periods[i].groupLabel !== periods[groupStart].groupLabel;
                        if (changed) {
                            const startCol = periodStartCol + groupStart;
                            const endCol = periodStartCol + i - 1;
                            if (endCol > startCol) ganttSheet.mergeCells(1,startCol,1,endCol);
                            const c = ganttSheet.getCell(1,startCol);
                            c.value = periods[groupStart].groupLabel;
                            c.alignment = {horizontal:'center'};
                            groupStart = i;
                        }
                    }
                }
                ganttSheet.mergeCells(1,1,1,leftHeaders.length);
                ganttSheet.getCell(1,1).value = `甘特圖｜匯出檢視尺度：${exportScaleLabel}（原始日期仍保留於工項總表 / 工時明細）`;
                this.styleExcelHeader(ganttSheet.getRow(2));
                ganttSheet.getRow(1).eachCell(cell => {
                    cell.font = {bold:true,color:{argb:'FF334155'}};
                    cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFE2E8F0'}};
                    cell.alignment = {horizontal:'center',vertical:'middle'};
                });
                [30,18,18,14,10,18,24,24,14,10].forEach((w,i)=>ganttSheet.getColumn(i+1).width=w);

                let rowNo = 3;
                let lastGroup = null;
                entries.forEach(({card, tabName}) => {
                    const group = `${card.project || '未分類專案'} / ${card.category || '未分類'}`;
                    if (group !== lastGroup) {
                        ganttSheet.mergeCells(rowNo,1,rowNo,Math.max(leftHeaders.length + periods.length, leftHeaders.length));
                        const gc = ganttSheet.getCell(rowNo,1);
                        gc.value = group;
                        gc.font = {bold:true,color:{argb:'FF3730A3'}};
                        gc.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFEEF2FF'}};
                        rowNo++;
                        lastGroup = group;
                    }
                    const planned = this.plannedMinutes(card);
                    const actual = this.totalMinutes(card);
                    const sharedValues = [
                        card.title||'未命名', card.project||'', card.category||'', this.statusLabel(card.status), `${this.progressValue(card)}%`,
                        `${this.formatMinutes(planned)} / ${this.formatMinutes(actual)}`,
                        `${card.dateStart||''} → ${card.dateEnd||''}`,
                        `${this.derivedActualStart(card)||''}${this.derivedActualEnd(card) ? ` → ${this.derivedActualEnd(card)}` : ''}`,
                        tabName
                    ];
                    for (let col=1; col<=sharedValues.length; col++) {
                        ganttSheet.mergeCells(rowNo,col,rowNo+1,col);
                        ganttSheet.getCell(rowNo,col).value = sharedValues[col-1];
                        ganttSheet.getCell(rowNo,col).alignment = {vertical:'middle',wrapText:true};
                    }
                    ganttSheet.getCell(rowNo,10).value = '📐 預計';
                    ganttSheet.getCell(rowNo+1,10).value = '⏱️ 實際';
                    ganttSheet.getCell(rowNo,10).fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFEEF2FF'}};
                    ganttSheet.getCell(rowNo+1,10).fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FFECFDF5'}};

                    const start = this.parseLocalDate(card.dateStart);
                    const end = this.parseLocalDate(card.dateEnd);
                    const cfg = this.colorConfig(card.color);
                    periods.forEach((period,idx)=>{
                        const col = periodStartCol + idx;
                        const planIntersects = !!(start && end && !(end < period.start || start > period.end));
                        if (planIntersects) {
                            ganttSheet.getCell(rowNo,col).fill = {type:'pattern',pattern:'solid',fgColor:{argb:`FF${cfg.light.replace('#','').toUpperCase()}`}};
                        }
                        let mins = 0;
                        this.getLogs(card).forEach(log => {
                            const d = this.parseLocalDate(log.workDate);
                            if (d && d >= period.start && d <= period.end) mins += this.logMinutes(log);
                        });
                        if (mins > 0) {
                            const cell = ganttSheet.getCell(rowNo+1,col);
                            cell.value = this.compactMinutes(mins);
                            cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:`FF${cfg.hex.replace('#','').toUpperCase()}`}};
                            cell.font = {bold:true,color:{argb:'FFFFFFFF'}};
                            cell.alignment = {horizontal:'center',vertical:'middle'};
                        }
                    });
                    ganttSheet.getCell(rowNo,1).fill = {type:'pattern',pattern:'solid',fgColor:{argb:`FF${cfg.light.replace('#','').toUpperCase()}`}};
                    ganttSheet.getRow(rowNo).height = 22;
                    ganttSheet.getRow(rowNo+1).height = 22;
                    rowNo += 2;
                });
                ganttSheet.views = [{state:'frozen', xSplit:leftHeaders.length, ySplit:2}];

                const buffer = await workbook.xlsx.writeBuffer();
                const blob = new Blob([buffer], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const stamp = this.localDateString().replace(/-/g,'');
                a.href = url; a.download = `白板工項與工時_${stamp}.xlsx`;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (err) {
                console.error(err);
                alert('Excel 匯出失敗：' + (err?.message || err));
            }
        }
    },


    // ==========================================
    // 🌟 終極沙盒 SPA (子任務雙向綁定) 🌟
    // ==========================================
    sandbox: {
        GIF_URL: "https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif",
        tickHandle: null,
        lastShownStatus: null,
        lastPersistAt: 0,

        initUI() {
            this.updateDisplay();
            const textarea = document.getElementById('sb-activeNoteArea');
            if (textarea) {
                textarea.addEventListener('keydown', function(e) {
                    if (e.key === 'Tab') {
                        e.preventDefault();
                        const start = this.selectionStart; const end = this.selectionEnd;
                        this.value = this.value.substring(0, start) + "    " + this.value.substring(end);
                        this.selectionStart = this.selectionEnd = start + 4;
                        app.sandbox.saveActiveNote();
                    }
                });
            }
        },

        switchLeftPanel(panel) {
            document.getElementById('sb-view-timer').style.display = panel === 'TIMER' ? 'block' : 'none';
            document.getElementById('sb-view-todo').style.display = panel === 'TODO' ? 'flex' : 'none';
            document.getElementById('sb-tab-timer').className = panel === 'TIMER' ? 'sb-tab-btn active' : 'sb-tab-btn';
            document.getElementById('sb-tab-todo').className = panel === 'TODO' ? 'sb-tab-btn active' : 'sb-tab-btn';
        },

        getActiveCards() { return app.state.workspaces[app.state.activeTabId] || []; },
        activeCard() { const id = app.state.sandbox.activeTaskId; return id ? app.worktime.getCard(id) : null; },

        parseSubtasks(content) {
            if (!content) return [];
            const subtasks = [];
            const regex = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
            content.split('\n').forEach((line, index) => {
                const match = line.match(regex);
                if (match) subtasks.push({ lineIndex: index, completed: match[1].toLowerCase() === 'x', text: match[2], raw: line });
            });
            return subtasks;
        },

        toggleSubtask(cardId, lineIndex) {
            const card = app.worktime.getCard(cardId);
            if (!card) return;
            const lines = String(card.content || '').split('\n');
            const line = lines[lineIndex] ?? '';
            if (line.includes('[ ]')) lines[lineIndex] = line.replace('[ ]', '[x]');
            else if (/\[x\]/i.test(line)) lines[lineIndex] = line.replace(/\[x\]/i, '[ ]');
            card.content = lines.join('\n');

            const subtasks = this.parseSubtasks(card.content);
            if (subtasks.length > 0 && subtasks.every(st => st.completed)) {
                app.worktime.markCompleted(card);
            } else if (subtasks.length > 0 && subtasks.some(st => !st.completed) && Number(card.status) === 2) {
                // 從「全部完成」重新打開任一子任務時，回到可工作的狀態，不保留 100% / 實際完成日。
                app.worktime.reopenCompleted(card, 1);
            }
            app.saveToLocal();
            this.renderTodo();
            if (app.state.sandbox.activeTaskId === cardId) document.getElementById('sb-activeNoteArea').value = card.content;
        },

        addTodo() {
            const input = document.getElementById('sb-newTodoTask');
            const text = input.value.trim();
            if (!text) return;
            const today = app.worktime.localDateString();
            let targetCard = this.activeCard();
            if (targetCard) {
                const prefix = targetCard.content && !targetCard.content.endsWith('\n') ? '\n' : '';
                targetCard.content = `${targetCard.content || ''}${prefix}- [ ] ${text}\n`;
                if (Number(targetCard.status) === 2) app.worktime.reopenCompleted(targetCard, 1);
            } else {
                // 沒有聚焦卡片時，收進「今天」的今日雜項（不會一直塞進很久以前那張）。
                targetCard = this.getActiveCards().find(c => c.title === '今日雜項' && (c.dateSingle === today || c.dateStart === today));
                if (!targetCard) {
                    targetCard = {
                        id: app.makeId('card'), title: '今日雜項', content: '', project: '日常',
                        dateMode: 'single', dateSingle: today, color: 'blue', status: 0, isMemo: false
                    };
                    app.state.workspaces[app.state.activeTabId].unshift(targetCard);
                }
                app.state.sandbox.activeTaskId = targetCard.id;
                const prefix = targetCard.content && !targetCard.content.endsWith('\n') ? '\n' : '';
                targetCard.content = `${targetCard.content || ''}${prefix}- [ ] ${text}\n`;
            }
            input.value = '';
            app.saveToLocal();
            this.persistTimer();
            this.renderTodo();
            this.refreshActiveNoteUI();
        },

        toggleTodoCard(id) {
            const card = app.worktime.getCard(id);
            if (!card) return;
            if (Number(card.status) === 2) app.worktime.reopenCompleted(card);
            else app.worktime.markCompleted(card);
            app.saveToLocal(); this.renderTodo(); this.refreshActiveNoteUI();
        },

        async clearCompletedCards() {
            const done = this.getActiveCards().filter(c => Number(c.status) === 2);
            if (!done.length) { app.ui.toast('這個分頁沒有已完成的卡片'); return; }
            const mins = done.reduce((sum, c) => sum + app.worktime.totalMinutes(c), 0);
            const pinned = done.filter(c => c.chroniclePinned).length;
            const ok = await app.ui.confirm('清除已完成卡片',
                `<p>會從這個分頁移除 <b>${done.length}</b> 張已完成卡片${mins ? `（含 <b>${app.worktime.formatMinutes(mins)}</b> 工時紀錄）` : ''}${pinned ? `，其中 ${pinned} 張在大事記裡` : ''}。</p><p>移除後甘特圖與 Excel 都不會再算進這些工時。卡片會先放進「🗂 資料 → 最近刪除」，需要時可以救回。</p>`, '移除', true);
            if (!ok) return;
            const ids = new Set(done.map(c => c.id));
            if (ids.has(app.state.sandbox.timerTaskId) && app.state.sandbox.timerStatus !== 'IDLE') this.stopTimer();
            if (!await app.backup.trashOrConfirm(done.map(card => ({ card, tabId: app.state.activeTabId })), '清除已完成')) return;
            app.state.workspaces[app.state.activeTabId] = this.getActiveCards().filter(c => !ids.has(c.id));
            if (ids.has(app.state.sandbox.activeTaskId)) this.setActiveTask(null);
            app.saveToLocal(); this.renderTodo();
        },

        setActiveTask(id) {
            const sb = app.state.sandbox;
            const oldId = sb.activeTaskId;
            if (oldId !== id && sb.timerStatus !== 'IDLE' && sb.timerTaskId !== id) {
                this.commitTimerSession('心流計時（切換任務自動結算）');
                sb.timerTaskId = id || null;
            }
            sb.activeTaskId = id;
            if (sb.timerStatus === 'IDLE') sb.timerTaskId = id || null;
            // 每一步各自保護：某張卡顯示出錯時，切換仍然完成，不會卡在上一張。
            [() => this.persistTimer(), () => this.refreshActiveNoteUI(), () => this.renderTodo(), () => this.updateDisplay(true), () => app.refreshTimerButtons()]
                .forEach(fn => { try { fn(); } catch (err) { app.ui.reportError(err, '切換任務'); } });
        },

        focusTaskForTimer(id) {
            app.switchView('sandbox');
            this.switchLeftPanel('TIMER');
            this.setActiveTask(id);
        },

        refreshActiveNoteUI() {
            const titleEl = document.getElementById('sb-activeTaskTitle');
            const iconEl = document.getElementById('sb-activeTaskIcon');
            const noteArea = document.getElementById('sb-activeNoteArea');
            const nextStepBox = document.getElementById('sb-nextStepBox');
            const nextStepInput = document.getElementById('sb-nextStepInput');
            if (!titleEl || !noteArea) return;
            const card = this.activeCard();
            if (card) {
                iconEl.style.display = 'inline'; titleEl.value = card.title || ''; titleEl.style.color = 'var(--primary)';
                titleEl.readOnly = false; noteArea.value = card.content || "";
                if (nextStepBox) nextStepBox.style.display = 'block';
                if (nextStepInput) nextStepInput.value = card.nextStep || '';
                app.entries.renderSandbox(card);
                return;
            }
            app.state.sandbox.activeTaskId = null;
            iconEl.style.display = 'none'; titleEl.value = "📝 全域沙盒草稿 (未綁定單一任務)"; titleEl.style.color = '#334155';
            titleEl.readOnly = true; noteArea.value = app.state.globalNotebook.free || "";
            if (nextStepBox) nextStepBox.style.display = 'none';
            if (nextStepInput) nextStepInput.value = '';
            app.entries.renderSandbox(null);
        },

        renameActiveTask() {
            const card = this.activeCard();
            if (!card) return;
            card.title = document.getElementById('sb-activeTaskTitle').value;
            app.saveToLocal();
            clearTimeout(this._renameTimer);
            this._renameTimer = setTimeout(() => this.renderTodo(), 300);
        },

        saveActiveNote() {
            const noteArea = document.getElementById('sb-activeNoteArea');
            const card = this.activeCard();
            if (card) card.content = noteArea.value;
            else app.state.globalNotebook.free = noteArea.value;
            app.saveToLocal();
            // 打「- [ ] 事項」時左側子任務即時出現（稍微延遲，避免每個字都重畫）。
            clearTimeout(this._todoTimer);
            this._todoTimer = setTimeout(() => this.renderTodo(), 350);
        },

        saveNextStep() {
            const card = this.activeCard();
            const input = document.getElementById('sb-nextStepInput');
            if (!card || !input) return;
            card.nextStep = input.value;
            card.nextAction = input.value;
            app.saveToLocal();
        },

        wrapMarkdown(prefix, suffix) {
            const noteArea = document.getElementById('sb-activeNoteArea');
            const start = noteArea.selectionStart; const end = noteArea.selectionEnd;
            const selectedText = noteArea.value.substring(start, end);
            noteArea.value = noteArea.value.substring(0, start) + prefix + selectedText + suffix + noteArea.value.substring(end);
            noteArea.focus(); noteArea.selectionStart = noteArea.selectionEnd = selectedText.length === 0 ? start + prefix.length : start + prefix.length + selectedText.length + suffix.length;
            this.saveActiveNote();
        },

        insertPrefix(prefix) {
            const noteArea = document.getElementById('sb-activeNoteArea'); const start = noteArea.selectionStart;
            noteArea.value = noteArea.value.substring(0, start) + prefix + noteArea.value.substring(start);
            noteArea.focus(); noteArea.selectionStart = noteArea.selectionEnd = start + prefix.length;
            this.saveActiveNote();
        },

        insertTemplate(type) {
            let tpl = "";
            if (type === 'bug') tpl = "\n### 🐛 異常現象\n\n### 🔬 測試假設\n\n### 🛠️ 下一步\n";
            else if (type === 'dissect') tpl = "\n### 🎯 現況與目標\n\n### 🚧 卡關點\n\n### 💡 解法構思\n- [ ] \n- [ ] \n";
            else if (type === 'review') tpl = "\n### ✅ 已完成\n\n### ❌ 待優化\n\n### 📌 備註\n";
            this.insertPrefix(tpl);
        },

        addQuickLog() {
            const inputEl = document.getElementById('sb-quickLogInput'); const text = inputEl.value.trim(); if (!text) return;
            const noteArea = document.getElementById('sb-activeNoteArea');
            const now = new Date(); const timeStr = `${now.getMonth() + 1}/${now.getDate()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
            noteArea.value += `\n**[${timeStr}]** ${text}`;
            inputEl.value = ''; noteArea.scrollTop = noteArea.scrollHeight; this.saveActiveNote();
        },

        async mergeSelectedCards() {
            const checkboxes = [...document.querySelectorAll('.todo-cb-merge:checked')];
            if (checkboxes.length < 2) { app.ui.toast('請勾選至少兩張卡片再合併', 'warn'); return; }
            const mergedTitle = prompt("合併後的卡片名稱：", "合併任務集");
            if (!mergedTitle) return;
            const sbm = app.state.sandbox;
            // 先把正在跑的計時記進原卡，再收集工時，避免這段時間跟著原卡一起被移走。
            if (sbm.timerStatus !== 'IDLE' && checkboxes.some(cb => cb.value === sbm.timerTaskId)) this.commitTimerSession('心流計時（合併前結算）');
            const sources = checkboxes.map(cb => app.worktime.getCard(cb.value)).filter(Boolean);
            const W = app.worktime;
            let highestPriority = 'blue';
            sources.forEach(card => {
                if (card.color === 'red') highestPriority = 'red';
                else if (card.color === 'yellow' && highestPriority !== 'red') highestPriority = 'yellow';
            });
            const projects = [...new Set(sources.map(c => String(c.project || '').trim()).filter(Boolean))];
            const starts = sources.map(c => W.plannedStart(c)).filter(Boolean).sort();
            const ends = sources.map(c => W.plannedEnd(c)).filter(Boolean).sort();
            const plannedTotal = sources.reduce((sum, c) => sum + W.plannedMinutes(c), 0);
            const nextSteps = sources.map(c => String(c.nextStep || '').trim()).filter(Boolean);
            const anyScheduled = sources.some(c => !c.isMemo);
            const newCard = {
                id: app.makeId('card'),
                title: mergedTitle,
                content: sources.map(c => `### 🧩 [合併來源] ${c.title || '未命名'}\n${String(c.content || '').trim()}`).join('\n\n---\n\n'),
                entries: sources.flatMap(c => c.entries || []),
                workLogs: sources.flatMap(c => c.workLogs || []),
                project: projects.length === 1 ? projects[0] : (projects.length ? '整理' : ''),
                color: highestPriority, status: 0, isMemo: !anyScheduled,
                dateMode: starts.length ? 'range' : 'single',
                dateStart: starts[0] || '', dateEnd: ends[ends.length - 1] || starts[0] || '',
                dateSingle: starts.length ? '' : W.localDateString()
            };
            if (plannedTotal > 0) newCard.plannedMinutes = plannedTotal;
            if (nextSteps.length) { newCard.nextStep = nextSteps.join('；'); newCard.nextAction = newCard.nextStep; }
            if (sources.some(c => c.chroniclePinned)) {
                newCard.chroniclePinned = true;
                newCard.chronicleDate = sources.map(c => c.chronicleDate).filter(Boolean).sort().pop() || W.localDateString();
                newCard.chronicleSummary = sources.map(c => c.chronicleSummary).filter(Boolean).join('；');
            }
            if (newCard.workLogs.length) W.ensureStarted(newCard, newCard.workLogs.map(l => l.workDate).filter(Boolean).sort()[0]);
            const sb = app.state.sandbox;
            const ids = new Set(sources.map(c => c.id));
            if (!await app.backup.trashOrConfirm(sources.map(card => ({ card, tabId: app.worktime.allCards().find(r => r.card.id === card.id)?.tabId || app.state.activeTabId })), '合併')) return;
            Object.keys(app.state.workspaces).forEach(t => { app.state.workspaces[t] = app.state.workspaces[t].filter(c => !ids.has(c.id)); });
            app.state.workspaces[app.state.activeTabId].unshift(newCard);
            if (ids.has(sb.timerTaskId)) sb.timerTaskId = newCard.id;
            app.saveToLocal(); this.renderTodo(); this.setActiveTask(newCard.id);
            app.ui.toast('已合併：筆記、子任務、工時與工作紀錄都已串接');
        },

        renderTodo() {
            const container = document.getElementById('sb-todoListContainer');
            if (!container) return;
            const esc = s => app.entries.escapeHtml(s);
            const cards = this.getActiveCards();
            const sorted = [...cards].sort((a, b) => {
                if ((a.status === 2) !== (b.status === 2)) return (a.status === 2) ? 1 : -1;
                const wA = a.color === 'red' ? 1 : (a.color === 'yellow' ? 2 : 3);
                const wB = b.color === 'red' ? 1 : (b.color === 'yellow' ? 2 : 3);
                return wA - wB;
            });
            if (sorted.length === 0) {
                container.innerHTML = "<div style='text-align:center; color:#aaa; padding:20px; font-size: 0.9rem;'>分頁內無卡片。<br>直接輸入任務，系統會幫你建檔！</div>";
                return;
            }
            const sb = app.state.sandbox;
            container.innerHTML = sorted.map(c => {
                const isActive = sb.activeTaskId === c.id;
                const timing = sb.timerStatus !== 'IDLE' && sb.timerTaskId === c.id;
                const completed = c.status === 2;
                const prioLabel = c.color === 'red' ? 'P1' : (c.color === 'yellow' ? 'P2' : 'P3');
                const prioColor = c.color === 'red' ? '#dc3545' : (c.color === 'yellow' ? '#ffc107' : '#007bff');
                const subtasks = this.parseSubtasks(c.content);
                const secs = app.worktime.totalSeconds(c);
                return `
                <div class="sb-todo-card ${isActive ? 'active-card' : ''}" onclick="if(event.target.tagName !== 'INPUT' && event.target.tagName !== 'BUTTON') app.sandbox.setActiveTask('${c.id}')" style="cursor: pointer;">
                    <div style="display: flex; align-items: flex-start;">
                        <div style="display: flex; flex-direction: column; align-items: center; margin-right: 8px; border-right: 1px solid #eee; padding-right: 6px;">
                            <span style="font-size: 0.65rem; color: #adb5bd;">合併</span>
                            <input type="checkbox" class="todo-cb-merge" value="${c.id}" style="cursor: pointer; transform: scale(1.1);">
                        </div>
                        <div style="display: flex; align-items: center; margin-right: 8px; padding-top: 6px;">
                            <input type="checkbox" style="transform: scale(1.3); cursor: pointer;" ${completed ? 'checked' : ''} onchange="app.sandbox.toggleTodoCard('${c.id}')">
                        </div>
                        <div style="flex-grow: 1; margin-left: 5px; overflow: hidden;">
                            <div style="margin-bottom: 2px;">
                                <span class="sb-badge" style="background:${prioColor}">${prioLabel}</span>
                                <span class="sb-badge" style="background:#6c757d; font-size:0.7em;">${esc(c.project || '未分類')}</span>
                                ${c.category ? `<span class="sb-badge" style="background:#64748b; font-size:0.7em;">${esc(c.category)}</span>` : ''}
                                ${secs > 0 ? `<span class="sb-badge" style="background:#4f46e5; font-size:0.7em;">⏱ ${app.worktime.formatDuration(secs)}</span>` : ''}
                                ${timing ? `<span class="sb-badge" style="background:#16a34a; font-size:0.7em;">計時中</span>` : ''}
                            </div>
                            <div style="font-size: 0.95rem; margin-top: 4px; font-weight: bold; color: ${isActive ? '#0056b3' : '#333'}; text-decoration: ${completed ? 'line-through' : 'none'}; opacity: ${completed ? 0.6 : 1};">${esc(c.title || '未命名')}</div>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 5px; margin-left: 5px;">
                            <button class="${isActive ? 'sb-btn-info' : 'sb-btn-outline'} sb-btn" style="padding:4px 8px; font-size:0.8rem;" onclick="app.sandbox.setActiveTask('${c.id}')">${isActive ? '🎯' : '📝'}</button>
                        </div>
                    </div>
                    ${subtasks.length ? `<div class="sb-subtasks-container">${subtasks.map(st => `
                        <div class="sb-subtask-item ${st.completed ? 'completed' : ''}">
                            <input type="checkbox" ${st.completed ? 'checked' : ''} onchange="app.sandbox.toggleSubtask('${c.id}', ${st.lineIndex});">
                            <span>${esc(st.text)}</span>
                        </div>`).join('')}</div>` : ''}
                </div>`;
            }).join('');
        },

        async promoteNodesToCards() {
            const nodes = app.state.nodes[app.state.activeTabId] || [];
            if (nodes.length === 0) { app.ui.toast('此分頁目前沒有發想節點'); return; }
            if (!await app.ui.confirm('轉換發想節點', `<p>把此分頁的 ${nodes.length} 個發想節點全部轉成任務卡片？棋盤上的棋子會被清空。</p>`, '轉換')) return;
            const today = app.worktime.localDateString();
            nodes.forEach(node => {
                let cardColor = 'blue';
                if (node.tag === 'q1') cardColor = 'red'; else if (node.tag === 'q3') cardColor = 'yellow'; else if (node.tag === 'q2') cardColor = 'green';
                app.state.workspaces[app.state.activeTabId].push({
                    id: app.makeId('card'), title: node.text, content: '', project: node.project || '發想',
                    category: '', progress: '', deliverable: '', acceptance: '', workLogs: [],
                    dateMode: 'single', dateSingle: today, color: cardColor, status: 0, isMemo: false
                });
            });
            app.state.nodes[app.state.activeTabId] = [];
            app.saveToLocal(); this.renderTodo(); app.ui.toast(`已轉換 ${nodes.length} 個節點`);
        },

        // ------------------------------------------
        // ⏱️ 計時器：用「開始時間」計算，背景分頁／休眠／重新整理都不會少算
        // ------------------------------------------
        elapsedMs() {
            const sb = app.state.sandbox;
            let ms = (sb.segments || []).reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
            if (sb.timerStatus === 'RUNNING' && sb.segStart) ms += Math.max(0, Date.now() - sb.segStart);
            return ms;
        },

        closeSegment(at = Date.now()) {
            const sb = app.state.sandbox;
            if (sb.segStart) {
                if (at > sb.segStart) sb.segments.push([sb.segStart, at]);
                sb.segStart = null;
            }
        },

        splitByDay(segments, withSpan = false) {
            const map = {}, span = {};
            (segments || []).forEach(([a, b]) => {
                let s = a;
                while (s < b) {
                    const d = new Date(s);
                    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
                    const e = Math.min(b, nextMidnight);
                    const key = app.worktime.localDateString(d);
                    map[key] = (map[key] || 0) + (e - s);
                    if (!span[key]) span[key] = [s, e];
                    else { span[key][0] = Math.min(span[key][0], s); span[key][1] = Math.max(span[key][1], e); }
                    s = e;
                }
            });
            return withSpan ? { map, span } : map;
        },

        // 同一個瀏覽器開了兩個分頁時，只有「目前這段計時」的擁有者能寫入工時，避免重複記兩次。
        ownsTimer() {
            const sb = app.state.sandbox;
            let saved = null;
            try { saved = JSON.parse(localStorage.getItem(this.timerKey()) || 'null'); } catch {}
            if (!saved) return true;
            if ((saved.sessionId || null) !== (sb.sessionId || null)) return false;
            if (saved.timerStatus === 'IDLE' && sb.timerStatus !== 'IDLE') return false;
            return true;
        },

        adoptStoredTimer() {
            let saved = null;
            try { saved = JSON.parse(localStorage.getItem(this.timerKey()) || 'null'); } catch {}
            if (!saved) return;
            const sb = app.state.sandbox;
            this.stopTick();
            sb.mode = saved.mode === 'POMODORO' ? 'POMODORO' : 'FLEXIBLE';
            sb.timerStatus = ['RUNNING', 'PAUSED'].includes(saved.timerStatus) ? saved.timerStatus : 'IDLE';
            sb.timerTaskId = saved.timerTaskId || null;
            sb.segStart = sb.timerStatus === 'RUNNING' ? (saved.segStart || Date.now()) : null;
            sb.segments = Array.isArray(saved.segments) ? saved.segments : [];
            sb.sessionId = saved.sessionId || null;
            if (sb.timerStatus === 'RUNNING') this.startTick();
            this.updateDisplay(true);
            app.refreshTimerButtons();
            this.renderTodo();
            // 另一個分頁記錄的工時，這裡的卡片也要跟著更新（資料本身會由 store.onStorage 同步）。
        },

        commitTimerSession(note = '心流計時') {
            const sb = app.state.sandbox;
            if (!this.ownsTimer()) { this.adoptStoredTimer(); return 0; }
            const wasRunning = sb.timerStatus === 'RUNNING';
            this.closeSegment();
            const taskId = sb.timerTaskId;
            const { map: byDay, span } = this.splitByDay(sb.segments, true);
            const totalMs = Object.values(byDay).reduce((a, b) => a + b, 0);
            sb.segments = [];
            const card = taskId ? app.worktime.getCard(taskId) : null;
            let written = 0;
            if (card) {
                Object.entries(byDay).sort().forEach(([day, ms]) => {
                    const sec = Math.round(ms / 1000);
                    if (sec > 0 && app.worktime.addTimerLog(taskId, sec, note, day, span[day])) written += sec;
                });
            } else if (totalMs >= 60 * 1000) {
                app.ui.toast(`這段 ${Math.round(totalMs / 60000)} 分鐘的計時沒有綁定卡片，沒有寫入工時。`, 'warn', 5000);
            }
            if (wasRunning) sb.segStart = Date.now();
            this.persistTimer();
            if (card) {
                app.refreshCard(taskId);
                if (sb.activeTaskId === taskId) app.entries.renderSandbox(card);
            }
            return written;
        },

        setTimerMode(mode) {
            const sb = app.state.sandbox;
            if (sb.timerStatus !== 'IDLE') this.stopTimer('心流計時（切換模式自動結算）');
            sb.mode = mode === 'POMODORO' ? 'POMODORO' : 'FLEXIBLE';
            document.getElementById('sb-btn-mode-flex').className = sb.mode === 'FLEXIBLE' ? 'sb-tab-btn active' : 'sb-tab-btn';
            document.getElementById('sb-btn-mode-pomo').className = sb.mode === 'POMODORO' ? 'sb-tab-btn active' : 'sb-tab-btn';
            this.persistTimer();
            this.updateDisplay(true);
        },

        startTimer() {
            const sb = app.state.sandbox;
            if (sb.timerStatus === 'RUNNING') return;
            if (sb.timerStatus === 'IDLE') {
                sb.timerTaskId = sb.activeTaskId || null;
                sb.segments = [];
            }
            const targetCard = sb.timerTaskId ? app.worktime.getCard(sb.timerTaskId) : null;
            if (targetCard && app.worktime.ensureStarted(targetCard)) {
                app.saveToLocal();
                app.refreshCard(targetCard.id);
                if (sb.activeTaskId === targetCard.id) app.entries.renderSandbox(targetCard);
            }
            const fresh = sb.timerStatus === 'IDLE';
            if (fresh) sb.sessionId = app.makeId('timer');
            else if (!this.ownsTimer()) { this.adoptStoredTimer(); return; }
            sb.timerStatus = 'RUNNING';
            sb.segStart = Date.now();
            this.persistTimer(fresh);
            this.startTick();
            this.renderTodo();
            this.updateDisplay(true);
            app.refreshTimerButtons();
        },

        pauseTimer() {
            const sb = app.state.sandbox;
            if (sb.timerStatus !== 'RUNNING') return;
            this.closeSegment();
            sb.timerStatus = 'PAUSED';
            this.stopTick();
            this.persistTimer();
            this.updateDisplay(true);
            app.refreshTimerButtons();
        },

        stopTimer(note = '心流計時') {
            const sb = app.state.sandbox;
            if (sb.timerStatus === 'IDLE') return;
            if (!this.ownsTimer()) { this.adoptStoredTimer(); app.ui.toast('這段計時已在另一個分頁結束並記錄'); return; }
            const taskId = sb.timerTaskId;
            sb.timerStatus = 'PAUSED'; // 讓 commit 不再接續新的一段
            this.closeSegment();
            const sec = this.commitTimerSession(note);
            sb.timerStatus = 'IDLE';
            sb.segStart = null;
            sb.segments = [];
            sb.timerTaskId = sb.activeTaskId || null;
            sb.sessionId = null;
            this.stopTick();
            this.persistTimer(true);
            this.updateDisplay(true);
            this.renderTodo();
            app.refreshTimerButtons();
            if (sec > 0 && taskId) {
                const card = app.worktime.getCard(taskId);
                app.ui.toast(`⏱️ 已記錄 ${app.worktime.formatDuration(sec)} 到「${card?.title || '未命名'}」`);
            }
        },

        // 卡片上的 ⏱️：直接在原地開始／停止，不用切到沙盒。
        quickTimer(cardId) {
            const sb = app.state.sandbox;
            const card = app.worktime.getCard(cardId);
            if (!card) return;
            if (sb.timerStatus !== 'IDLE' && sb.timerTaskId === cardId) { this.stopTimer(); return; }
            if (sb.timerStatus !== 'IDLE') {
                const prev = app.worktime.getCard(sb.timerTaskId);
                this.commitTimerSession('心流計時（切換任務自動結算）');
                sb.timerTaskId = cardId;
                sb.activeTaskId = cardId;
                if (sb.timerStatus === 'PAUSED') { sb.timerStatus = 'IDLE'; this.startTimer(); }
                else { app.worktime.ensureStarted(card) && app.saveToLocal(); this.persistTimer(); this.updateDisplay(true); app.refreshTimerButtons(); this.renderTodo(); }
                app.ui.toast(`改為計時「${card.title || '未命名'}」${prev ? `（「${prev.title || '未命名'}」已記錄）` : ''}`);
                return;
            }
            sb.activeTaskId = cardId;
            this.startTimer();
            app.ui.toast(`⏱️ 開始計時「${card.title || '未命名'}」，再按一次 ⏹ 停止並記錄`);
        },

        startTick() {
            this.stopTick();
            this.tickHandle = setInterval(() => this.tick(), 1000);
        },
        stopTick() { if (this.tickHandle) clearInterval(this.tickHandle); this.tickHandle = null; },

        tick() {
            const sb = app.state.sandbox;
            if (sb.timerStatus !== 'RUNNING') { this.stopTick(); return; }
            if (sb.mode === 'POMODORO') {
                const closed = (sb.segments || []).reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
                if (closed + (Date.now() - sb.segStart) >= POMODORO_MS) {
                    this.closeSegment(sb.segStart + (POMODORO_MS - closed));
                    sb.timerStatus = 'PAUSED';
                    this.stopTimer('番茄鐘');
                    app.ui.toast('🍅 25 分鐘到了，休息一下！這段已記錄。', 'info', 8000);
                    try { if (navigator.vibrate) navigator.vibrate(300); } catch {}
                    return;
                }
            }
            if (Date.now() - this.lastPersistAt > 20000) this.persistTimer();
            this.updateDisplay();
        },

        timerKey() { return app.currentUser ? `whiteboard_timer_${app.currentUser.uid}` : null; },

        persistTimer(force = false) {
            const key = this.timerKey();
            if (!key) return;
            // 另一個分頁已經接手（開始新的計時或已經停止）：不要用這頁的舊狀態蓋回去。
            if (!force && !this.ownsTimer()) { this.adoptStoredTimer(); return; }
            const sb = app.state.sandbox;
            this.lastPersistAt = Date.now();
            try {
                localStorage.setItem(key, JSON.stringify({
                    mode: sb.mode, timerStatus: sb.timerStatus, timerTaskId: sb.timerTaskId,
                    segStart: sb.segStart, segments: sb.segments, activeTaskId: sb.activeTaskId,
                    sessionId: sb.sessionId || null, lastSeenAt: Date.now()
                }));
            } catch (err) { console.warn('計時狀態未保存', err); }
        },

        resetTimerState() {
            const sb = app.state.sandbox;
            this.stopTick();
            Object.assign(sb, { timerStatus: 'IDLE', timerTaskId: null, segStart: null, segments: [], sessionId: null });
            this.persistTimer(true);
            this.updateDisplay(true);
        },

        async restoreTimer() {
            const key = this.timerKey();
            const sb = app.state.sandbox;
            Object.assign(sb, { timerStatus: 'IDLE', timerTaskId: null, segStart: null, segments: [], mode: 'FLEXIBLE', sessionId: null });
            let saved = null;
            try { saved = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
            if (saved) {
                sb.mode = saved.mode === 'POMODORO' ? 'POMODORO' : 'FLEXIBLE';
                if (saved.activeTaskId && app.worktime.getCard(saved.activeTaskId)) sb.activeTaskId = saved.activeTaskId;
            }
            document.getElementById('sb-btn-mode-flex').className = sb.mode === 'FLEXIBLE' ? 'sb-tab-btn active' : 'sb-tab-btn';
            document.getElementById('sb-btn-mode-pomo').className = sb.mode === 'POMODORO' ? 'sb-tab-btn active' : 'sb-tab-btn';
            if (!saved || saved.timerStatus === 'IDLE' || !saved.timerStatus) { this.updateDisplay(true); return; }

            sb.timerStatus = saved.timerStatus === 'RUNNING' ? 'RUNNING' : 'PAUSED';
            sb.timerTaskId = saved.timerTaskId || null;
            sb.segStart = sb.timerStatus === 'RUNNING' ? (saved.segStart || Date.now()) : null;
            sb.segments = Array.isArray(saved.segments) ? saved.segments.filter(x => Array.isArray(x) && x.length === 2) : [];
            sb.sessionId = saved.sessionId || null;
            if (sb.timerStatus === 'RUNNING') this.startTick();
            this.updateDisplay(true);
            app.refreshTimerButtons();

            const card = sb.timerTaskId ? app.worktime.getCard(sb.timerTaskId) : null;
            const name = card ? `「${card.title || '未命名'}」` : '（未綁定卡片）';
            const lastSeen = Number(saved.lastSeenAt) || sb.segStart || Date.now();
            if (sb.timerStatus === 'RUNNING' && Date.now() - lastSeen > 30 * 60 * 1000) {
                const total = Math.round(this.elapsedMs() / 60000);
                const upTo = Math.round(((sb.segments || []).reduce((s, [a, b]) => s + (b - a), 0) + Math.max(0, lastSeen - sb.segStart)) / 60000);
                const choice = await app.ui.dialog({
                    title: '計時器一直在跑',
                    html: `<p>${app.entries.escapeHtml(name)} 的計時從上次開著頁面（${app.ui.fmtTime(lastSeen)}）之後就沒人看，但一直沒有停。</p><p>目前累計 <b>${app.worktime.formatMinutes(total)}</b>；如果只算到 ${app.ui.fmtTime(lastSeen)} 是 <b>${app.worktime.formatMinutes(upTo)}</b>。</p>`,
                    buttons: [
                        { label: '這段不要記', value: 'discard', danger: true },
                        { label: '全部算進去，繼續計時', value: 'all' },
                        { label: `只算到 ${app.ui.fmtTime(lastSeen)} 並停止`, value: 'cut', primary: true }
                    ]
                });
                if (choice === 'cut') {
                    this.closeSegment(Math.max(sb.segStart || lastSeen, lastSeen));
                    sb.timerStatus = 'PAUSED';
                    this.stopTimer();
                } else if (choice === 'discard') {
                    this.resetTimerState();
                    sb.timerTaskId = sb.activeTaskId || null;
                    app.refreshTimerButtons();
                    app.ui.toast('已捨棄這段計時');
                }
            } else if (sb.timerStatus === 'RUNNING') {
                app.ui.toast(`⏱️ 接續先前的計時：${name}`);
            }
        },

        fmtClock(sec) {
            const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
            return (h > 0 ? `${String(h).padStart(2, '0')}:` : '') + `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        },

        displaySeconds() {
            const sb = app.state.sandbox;
            const el = Math.floor(this.elapsedMs() / 1000);
            if (sb.mode === 'POMODORO') return Math.max(0, Math.round(POMODORO_MS / 1000) - el);
            return el;
        },

        updateDisplay(force = false) {
            const sb = app.state.sandbox;
            const timeStr = this.fmtClock(this.displaySeconds());
            const display = document.getElementById('sb-timeDisplay');
            if (display) display.innerText = timeStr;
            const pillTime = document.getElementById('timer-pill-time');
            if (pillTime) pillTime.textContent = timeStr;

            if (!force && this.lastShownStatus === `${sb.timerStatus}|${sb.timerTaskId}|${sb.activeTaskId}|${sb.mode}`) {
                const targetBox = document.getElementById('sb-timerTarget');
                const acc = targetBox?.querySelector('.timer-acc');
                if (acc) acc.textContent = app.worktime.formatDuration(Math.floor(this.elapsedMs() / 1000));
                return;
            }
            this.lastShownStatus = `${sb.timerStatus}|${sb.timerTaskId}|${sb.activeTaskId}|${sb.mode}`;
            const esc = s => app.entries.escapeHtml(s);
            const gifBox = document.getElementById('sb-gifContainer');
            const statusText = document.getElementById('sb-statusText');
            const targetBox = document.getElementById('sb-timerTarget');
            const targetCard = sb.timerTaskId ? app.worktime.getCard(sb.timerTaskId) : null;
            const activeCard = sb.activeTaskId ? app.worktime.getCard(sb.activeTaskId) : null;
            if (targetBox) {
                if (targetCard && sb.timerStatus !== 'IDLE') {
                    targetBox.innerHTML = `記錄到：<strong>${esc(targetCard.title || '未命名')}</strong><br>本段已累積 <span class="timer-acc">${app.worktime.formatDuration(Math.floor(this.elapsedMs() / 1000))}</span>，停止時自動寫入卡片（跨午夜會自動分日）。`;
                } else if (activeCard) {
                    targetBox.innerHTML = `準備記錄到：<strong>${esc(activeCard.title || '未命名')}</strong><br>按「啟動」後開始累積工時。`;
                } else {
                    targetBox.innerText = '目前未綁定卡片。計時仍可使用，但不會寫入工時；先從任務矩陣選一張卡，或直接按卡片上的 ⏱️。';
                }
            }
            if (display && gifBox && statusText) {
                if (sb.timerStatus === 'RUNNING') {
                    display.style.color = '#28a745';
                    gifBox.innerHTML = `<img src="${this.GIF_URL}" alt="">`; statusText.innerText = '工作中';
                } else if (sb.timerStatus === 'PAUSED') {
                    display.style.color = '#ffc107';
                    gifBox.innerHTML = `<span style="color:#aaa">暫停</span>`; statusText.innerText = '暫停中';
                } else {
                    display.style.color = '#343a40';
                    gifBox.innerHTML = `<span style="color:#ccc">停止</span>`; statusText.innerText = '閒置';
                }
            }
            this.renderPill(targetCard);
        },

        renderPill(targetCard) {
            const pill = document.getElementById('timer-pill');
            if (!pill) return;
            const sb = app.state.sandbox;
            const esc = s => app.entries.escapeHtml(s);
            if (sb.timerStatus === 'IDLE') {
                pill.className = 'btn timer-pill';
                pill.innerHTML = `<span onclick="app.switchView('sandbox')">⏱️ <span class="nav-btn-label">心流</span></span>`;
                return;
            }
            const running = sb.timerStatus === 'RUNNING';
            pill.className = `btn timer-pill ${running ? 'running' : 'paused'}`;
            pill.innerHTML = `<span class="timer-pill-main" onclick="app.switchView('sandbox')" title="打開心流沙盒">${running ? '●' : '❚❚'} <span id="timer-pill-time">${this.fmtClock(this.displaySeconds())}</span> <span class="timer-pill-title">${esc(targetCard?.title || '未綁定')}</span></span>`
                + `<button type="button" class="timer-pill-btn" title="${running ? '暫停' : '繼續'}" onclick="event.stopPropagation(); app.sandbox.${running ? 'pauseTimer' : 'startTimer'}()">${running ? '⏸' : '▶'}</button>`
                + `<button type="button" class="timer-pill-btn" title="停止並記錄" onclick="event.stopPropagation(); app.sandbox.stopTimer()">⏹</button>`;
        },

        syncDeadlineInputs() {
            const t = document.getElementById('sb-deadlineTask');
            const d = document.getElementById('sb-deadlineDate');
            if (t) t.value = app.state.sandbox.deadlineTask || '';
            if (d) d.value = app.state.sandbox.deadlineDate || '';
            this.renderCountdown();
        },

        updateCountdown() {
            app.state.sandbox.deadlineTask = document.getElementById('sb-deadlineTask').value;
            app.state.sandbox.deadlineDate = document.getElementById('sb-deadlineDate').value;
            app.saveToLocal();
            this.renderCountdown();
        },

        renderCountdown() {
            const box = document.getElementById('sb-countdownDisplay');
            if (!box) return;
            const task = app.state.sandbox.deadlineTask || '';
            const target = app.worktime.parseLocalDate(app.state.sandbox.deadlineDate);
            if (!target) { box.style.display = 'none'; return; }
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const diffDays = Math.round((target - today) / 86400000);
            box.style.display = 'block';
            box.style.color = 'white';
            if (diffDays > 0) { box.style.background = '#dc3545'; box.textContent = `🔥 ${task} 倒數：${diffDays} 天`; }
            else if (diffDays === 0) { box.style.background = '#ffc107'; box.style.color = '#333'; box.textContent = `🔥 ${task} 今天截止！`; }
            else { box.style.background = '#6c757d'; box.textContent = `🚨 ${task} 已過期 ${Math.abs(diffDays)} 天`; }
        },

        downloadMarkdown() {
            const cards = this.getActiveCards();
            const completed = cards.filter(c => c.status === 2).length;
            let md = `# 🌟 心流當日總結\n*結算時間: ${new Date().toLocaleString('zh-TW')}*\n\n`;
            md += `📊 **戰報統計**：母專案完成 **${completed}** 項 / 總共 **${cards.length}** 項\n\n---\n\n`;
            if ((app.state.globalNotebook.free || '').trim()) md += `## 📝 全域筆記\n\n${app.state.globalNotebook.free.trim()}\n\n---\n\n`;
            const formatCard = (c) => {
                let str = `${c.status === 2 ? '- [x]' : '- [ ]'} **${c.title || '未命名'}**\n`;
                if (c.content && c.content.trim()) str += c.content.trim().split('\n').map(l => `    ${l}`).join('\n') + `\n\n`;
                else str += `\n`;
                return str;
            };
            const p1 = cards.filter(c => c.color === 'red'); const p2 = cards.filter(c => c.color === 'yellow'); const p3 = cards.filter(c => c.color !== 'red' && c.color !== 'yellow');
            if (p1.length > 0) { md += `## 🔴 【P1 · 核心攻堅】\n\n`; p1.forEach(c => md += formatCard(c)); }
            if (p2.length > 0) { md += `## 🟡 【P2 · 戰術推進】\n\n`; p2.forEach(c => md += formatCard(c)); }
            if (p3.length > 0) { md += `## 🔵 【P3 · 日常雜務】\n\n`; p3.forEach(c => md += formatCard(c)); }
            const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
            a.download = `心流備份_${app.worktime.localDateString()}.md`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
        }
    },

    // ==========================================
    // UI 視圖渲染與控制
    // ==========================================
    switchView(viewName) {
        this.state.view = viewName;
        document.querySelectorAll('.view-container').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.toolbar .btn').forEach(el => el.classList.remove('active'));
        if (document.getElementById('view-' + viewName)) document.getElementById('view-' + viewName).classList.add('active');
        if (document.getElementById('btn-view-' + viewName)) document.getElementById('btn-view-' + viewName).classList.add('active');
        if (this.state.showProjectBar) document.getElementById('btn-project-bar')?.classList.add('active');
        if (this.taskNav?.ui?.open) document.getElementById('btn-task-nav')?.classList.add('active');
        this.rememberPrefs();

        if (viewName === 'sandbox') {
            this.renderTabs();
            this.sandbox.refreshActiveNoteUI();
            this.sandbox.renderTodo();
            this.sandbox.updateDisplay(true);
        } else {
            this.renderAll();
        }
    },

    renderAll() {
        this.renderTabs(); if (this.state.showProjectBar) this.renderProjectBar();
        if (this.state.view === 'timeline') this.renderTimeline();
        else if (this.state.view === 'matrix') this.renderMatrix();
        else if (this.state.view === 'chronicle') this.renderChronicle();
        else if (this.state.view === 'gantt') this.renderGantt();
        else if (this.state.view === 'calendar') this.renderCalendar();
        else if (this.state.view === 'report') this.report.render();
        else if (this.state.view === 'sandbox') this.sandbox.renderTodo();
    },

    toggleProjectBar(forceOn = null) {
        this.state.showProjectBar = forceOn === null ? !this.state.showProjectBar : !!forceOn;
        document.getElementById('project-bar').style.display = this.state.showProjectBar ? 'flex' : 'none';
        document.body.classList.toggle('has-project-bar', this.state.showProjectBar);
        document.getElementById('btn-project-bar')?.classList.toggle('active', this.state.showProjectBar);
        this.renderProjectBar();
        this.rememberPrefs();
    },
    openNotebook() { document.getElementById('nb-template').value = this.state.globalNotebook.template; this.renderNotebookArea(); document.getElementById('modal-notebook').style.display = 'flex'; },
    closeNotebook() { document.getElementById('modal-notebook').style.display = 'none'; },
    toggleTsumego() { this.state.tsumego.isOpen = !this.state.tsumego.isOpen; const panel = document.getElementById('tsumego-panel'); if(this.state.tsumego.isOpen) { panel.style.display = 'block'; if(window.innerWidth > 768 && panel.style.transform !== 'none' && !panel.style.left) { panel.style.top = '10vh'; panel.style.left = '10vw'; } this.renderTsumegoStones(); } else { panel.style.display = 'none'; } },

    renderTabs() {
        const esc = s => this.entries.escapeHtml(s);
        const isMobile = window.innerWidth <= 768;
        const html = this.state.tabs.map(t => {
            const isActive = t.id === this.state.activeTabId;
            const gearBtn = (isActive && !isMobile) ? `<div style="margin-top:10px; font-size:1.1rem; cursor:pointer;" title="管理工作區" onclick="event.stopPropagation(); app.tabsManager.open('${t.id}')">⚙️</div>` : '';
            return `<div class="tab-item ${isActive ? 'active' : ''}" onclick="app.actions.switchTab('${t.id}')" oncontextmenu="event.preventDefault(); app.tabsManager.open('${t.id}')"><div class="tab-name">${esc(t.name)}</div>${gearBtn}</div>`;
        }).join('') + `<div class="tab-add" onclick="app.tabsManager.open(null, true)" title="新增或管理工作區">＋</div>`;
        document.getElementById('tab-bar').innerHTML = html;
    },

    renderProjectBar() {
        const esc = s => this.entries.escapeHtml(s);
        const cards = this.state.workspaces[this.state.activeTabId] || []; const nodes = this.state.nodes[this.state.activeTabId] || [];
        this._projectBarList = [...new Set([...cards.map(c => c.project), ...nodes.map(n => n.project)].filter(p => p && p.trim() !== ''))];
        let html = `<div class="proj-badge" onclick="app.setFilter('project', null)">清除過濾</div>`;
        this._projectBarList.forEach((p, i) => { const active = this.state.filters.activeProject === p ? 'active' : ''; html += `<div class="proj-badge ${active}" onclick="app.setFilterIndex(${i})">${esc(p)}</div>`; });
        document.getElementById('project-bar').innerHTML = html;
    },

    openProjectLab(projectName = '') {
        this.store.flush();
        this.sandbox.persistTimer();
        const q = projectName ? `?projectName=${encodeURIComponent(projectName)}` : '';
        location.href = `../workflow/${q}`;
    },

    setFilterIndex(i) { this.setFilter('project', this._projectBarList?.[i] ?? null); },

    timelineSortKey(card) {
        return card.dateMode === 'range' ? (card.dateStart || '') : (card.dateSingle || '');
    },

    renderTimeline() {
        const esc = s => this.entries.escapeHtml(s);
        let cards = [...(this.state.workspaces[this.state.activeTabId] || [])];
        if (this.state.filters.activeProject) cards = cards.filter(c => c.project === this.state.filters.activeProject);
        // 排序只排「顯示用的複本」，不改動資料本身的順序。
        cards.sort((a, b) => {
            const dA = this.timelineSortKey(a), dB = this.timelineSortKey(b);
            if (!dA && !dB) return 0;
            if (!dA) return 1;
            if (!dB) return -1;
            return dA.localeCompare(dB);
        });

        const groupedCards = {};
        cards.forEach(card => {
            const projName = String(card.project || '').trim() || '日常雜項 (未分類)';
            if (!groupedCards[projName]) groupedCards[projName] = [];
            groupedCards[projName].push(card);
        });

        const tabOptionsHtml = this.state.tabs.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
        const collapsed = this.prefs.collapsedGroups || {};

        let html = '';
        for (const [project, projCards] of Object.entries(groupedCards)) {
            const gkey = `${this.state.activeTabId}::${project}`;
            const isCollapsed = !!collapsed[gkey];
            html += `
            <div class="timeline-group" style="margin-top: 15px; margin-bottom: 10px;">
                <div class="timeline-group-head" data-gkey="${esc(gkey)}" onclick="app.toggleTimelineGroup(this)">
                    <span>${esc(project)} <span style="font-size: 0.8rem; color: #64748b; margin-left: 5px;">(${projCards.length} 筆任務)</span></span>
                    <button type="button" class="group-lab-btn" title="請 AI 老師示範這個專案怎麼拆" onclick="event.stopPropagation(); app.coach.open({ template: 'wbs', project: ${esc(JSON.stringify(projCards[0]?.project?.trim() || ''))} })">🧑‍🏫 拆解</button>
                    <button type="button" class="group-lab-btn" style="margin-left:0" title="在 Project Lab 打開這個專案（釐清、復盤、AI 討論）" onclick="event.stopPropagation(); app.openProjectLab(${esc(JSON.stringify(projCards[0]?.project?.trim() || '未分類'))})">🔬 復盤</button>
                    <span class="toggle-icon" style="font-size: 0.8rem; color: #94a3b8;">${isCollapsed ? '▶' : '▼'}</span>
                </div>
                <div class="timeline-group-content" style="padding-left: 10px; margin-top: 10px; ${isCollapsed ? 'display:none;' : ''}">
                    ${isCollapsed ? '' : projCards.map(card => this.renderTimelineCard(card, tabOptionsHtml)).join('')}
                </div>
            </div>`;
        }

        if (cards.length === 0) {
            html = `<div style="text-align:center; padding: 40px; color: #94a3b8;">此區域目前沒有卡片，按下方「＋ 新增」開始。</div>`;
        }

        document.getElementById('timeline-render-target').innerHTML = html;
        this.autosizeTextareas(document.getElementById('timeline-render-target'));
    },

    autosizeTextareas(root) {
        if (!root) return;
        requestAnimationFrame(() => {
            const els = [...root.querySelectorAll('.input-content')];
            els.forEach(el => { el.style.height = 'auto'; });
            const heights = els.map(el => el.scrollHeight);
            els.forEach((el, i) => { el.style.height = heights[i] + 'px'; });
        });
    },

    toggleTimelineGroup(head) {
        const key = head.dataset.gkey;
        if (!this.prefs.collapsedGroups) this.prefs.collapsedGroups = {};
        this.prefs.collapsedGroups[key] = !this.prefs.collapsedGroups[key];
        this.store.savePrefs();
        this.ui.withFocus(() => this.renderTimeline());
    },

    timerButtonHtml(card) {
        const sb = this.state.sandbox;
        const on = sb.timerStatus !== 'IDLE' && sb.timerTaskId === card.id;
        return `<button class="icon-btn card-timer-btn ${on ? 'running' : ''}" data-card="${card.id}" onclick="app.sandbox.quickTimer('${card.id}')" title="${on ? '停止並記錄工時' : '開始計時（記到這張卡）'}">${on ? '⏹' : '⏱️'}</button>`;
    },

    renderTimelineCard(card, tabOptionsHtml = null) {
        const esc = s => this.entries.escapeHtml(s);
        const id = card.id;
        const fk = field => `data-fk="${esc(`timeline:${id}:${field}`)}"`;
        if (tabOptionsHtml === null) tabOptionsHtml = this.state.tabs.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
        const dateHtml = card.isMemo
            ? `<span class="free-card-note">自由卡｜不進甘特與工項 Excel</span>`
            : (card.dateMode === 'single'
                ? `<span style="font-size:0.8rem;color:#64748b;">預計</span><input type="date" class="input-date" ${fk('dateSingle')} value="${esc(card.dateSingle || '')}" onchange="app.actions.updateCardDate('${id}', 'dateSingle', this.value)">`
                : `<span style="font-size:0.8rem;color:#64748b;">預計起</span><input type="date" class="input-date" ${fk('dateStart')} value="${esc(card.dateStart || '')}" onchange="app.actions.updateCardDate('${id}', 'dateStart', this.value)"><span style="font-size:0.8rem;color:#64748b;">迄</span><input type="date" class="input-date" ${fk('dateEnd')} value="${esc(card.dateEnd || '')}" onchange="app.actions.updateCardDate('${id}', 'dateEnd', this.value)">`);
        const nextStep = String(card.nextStep || '').trim();
        return `
            <div class="card-wrapper" data-wrap-id="${id}"><div class="card-dot"></div>
                <div class="card ${card.isMemo ? 'memo-mode' : ''}" data-color="${esc(card.color || 'blue')}" data-id="${id}">
                    <div class="card-header">
                        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                            <div class="status-dot status-${Number(card.status) || 0}" onclick="app.actions.cycleStatus('${id}')" title="${esc(this.worktime.statusLabel(card.status))}（點擊切換）"></div>
                            <button class="icon-btn" onclick="app.actions.toggleMemo('${id}')" title="${card.isMemo ? '自由卡：點擊改為排程工項' : '排程工項：點擊改為自由卡'}">${card.isMemo ? '♾️' : '📅'}</button>
                            ${dateHtml}
                            <span class="card-badges" id="badges-${id}">${this.cardBadgesHtml(card)}</span>
                        </div>
                        <div style="display:flex; gap:5px;">
                            <button class="icon-btn chronicle-pin-btn ${card.chroniclePinned ? 'active' : ''}" onclick="app.actions.toggleChronicle('${id}')" title="${card.chroniclePinned ? '移出大事記' : '加入大事記'}">${card.chroniclePinned ? '⭐' : '☆'}</button>
                            ${this.timerButtonHtml(card)}
                            ${card.isMemo ? '' : `<button class="icon-btn" onclick="app.actions.toggleDateMode('${id}')" title="單日／區間">↔️</button>`}
                            <button class="icon-btn" onclick="app.actions.cycleColor('${id}')" title="切換標記顏色">🎨</button>
                        </div>
                    </div>
                    <div class="card-body">
                        <input type="text" class="input-title" ${fk('title')} value="${esc(card.title)}" placeholder="🏷️ 標題..." oninput="app.actions.editCardText('${id}', 'title', this.value)">
                        <textarea class="input-content" ${fk('content')} placeholder="📝 寫下卡片細節..." oninput="this.style.height='auto'; this.style.height=this.scrollHeight+'px'; app.actions.editCardText('${id}', 'content', this.value)">${esc(card.content)}</textarea>
                        <div class="next-step-preview" id="next-preview-${id}" ${nextStep ? '' : 'style="display:none"'} onclick="app.actions.openPlanning('${id}')" title="點擊編輯下一步">➡ 下一步：<span>${esc(nextStep)}</span></div>
                        ${this.worktime.renderPlanningPanel(card, 'timeline')}
                        ${this.worktime.renderPanel(card, 'timeline')}
                        ${this.entries.renderCardPanel(card, 'timeline')}
                    </div>
                    <div class="card-footer" style="display: flex; gap: 8px; align-items: center; justify-content: flex-end;">
                        <input type="text" class="input-project" ${fk('project')} value="${esc(card.project)}" placeholder="#專案名稱" oninput="app.actions.editCardText('${id}', 'project', this.value)" onchange="app.ui.renderWhenIdle()">
                        <select class="icon-btn" style="width: auto; padding: 0 5px; font-size: 0.85rem;" onchange="if(this.value) { app.actions.moveCard('${id}', this.value); this.value=''; }">
                            <option value="" disabled selected>🚀 轉移至...</option>${tabOptionsHtml}
                        </select>
                        <button class="icon-btn" onclick="app.coach.open({ template: 'stuck', cardId: '${id}' })" title="卡住了？請 AI 老師帶你想下一步" style="width:34px; height:34px;">🧑‍🏫</button>
                        <button class="icon-btn" onclick="app.actions.deleteCard('${id}')" style="color:#ef4444; border-color:#fca5a5; width:34px; height:34px;" title="刪除此卡片">🗑️</button>
                    </div>
                </div>
            </div>`;
    },

    cardBadgesHtml(card) {
        const esc = s => this.entries.escapeHtml(s);
        const who = String(card.waitingWho || '').trim();
        const what = String(card.waitingWhat || '').trim();
        if (!who && !what) return '';
        const today = this.worktime.localDateString();
        const due = card.followUpDate && card.followUpDate <= today && Number(card.status) !== 2;
        const label = `⏳ 等${who ? ' ' + who : ''}${card.followUpDate ? ` · ${due ? '該追了' : String(card.followUpDate || '').slice(5) + ' 追'}` : ''}`;
        return `<span class="waiting-badge ${due ? 'due' : ''}" title="${esc(`等 ${who || '（未填）'}：${what || '（未填）'}`)}">${esc(label)}</span>`;
    },

    updateCardBadges(cardId) {
        const card = this.worktime.getCard(cardId);
        const el = document.getElementById(`badges-${cardId}`);
        if (card && el) el.innerHTML = this.cardBadgesHtml(card);
    },

    // 只重畫一張卡片（狀態、顏色、日期、工時變動時），不重畫整個時間軸。
    refreshCard(cardId, source = 'timeline') {
        this.ui.defer(() => {
            const card = this.worktime.getCard(cardId);
            if (source === 'sandbox' || this.state.view === 'sandbox') {
                if (card && this.state.sandbox.activeTaskId === cardId) this.entries.renderSandbox(card);
                this.sandbox.renderTodo();
                if (source === 'sandbox') return;
            }
            const wrap = document.querySelector(`#timeline-render-target .card-wrapper[data-wrap-id="${CSS.escape(cardId)}"]`);
            if (!wrap) return;
            if (!card) { wrap.remove(); return; }
            const tmp = document.createElement('div');
            tmp.innerHTML = this.renderTimelineCard(card).trim();
            const fresh = tmp.firstElementChild;
            wrap.replaceWith(fresh);
            this.autosizeTextareas(fresh);
        });
    },

    refreshTimerButtons() {
        const sb = this.state.sandbox;
        document.querySelectorAll('.card-timer-btn').forEach(btn => {
            const on = sb.timerStatus !== 'IDLE' && btn.dataset.card === sb.timerTaskId;
            btn.classList.toggle('running', on);
            btn.textContent = on ? '⏹' : '⏱️';
            btn.title = on ? '停止並記錄工時' : '開始計時（記到這張卡）';
        });
    },

    updateNextStepPreview(cardId) {
        const card = this.worktime.getCard(cardId);
        const el = document.getElementById(`next-preview-${cardId}`);
        if (!card || !el) return;
        const text = String(card.nextStep || '').trim();
        el.style.display = text ? '' : 'none';
        const span = el.querySelector('span');
        if (span) span.textContent = text;
    },

    renderMatrix() {
        let nodes = this.state.nodes[this.state.activeTabId] || []; 
        if (this.state.filters.activeProject) nodes = nodes.filter(n => n.project === this.state.filters.activeProject);
        
        const getTagHtml = (tagVal) => {
            if (tagVal === 'q1') return `<div class="node-tag tag-q1">🔥 重要・緊急</div>`; if (tagVal === 'q2') return `<div class="node-tag tag-q2">📅 重要・不急</div>`;
            if (tagVal === 'q3') return `<div class="node-tag tag-q3">⚡ 緊急・不重</div>`; if (tagVal === 'q4') return `<div class="node-tag tag-q4">☕ 不重・不急</div>`;
            return '';
        };

        let html = ''; const starPositions = [3, 9, 15];
        starPositions.forEach(x => { starPositions.forEach(y => { html += `<div class="star-point" style="left: ${(x/18)*100}%; top: ${(y/18)*100}%;"></div>`; }); });

        html += nodes.map(n => {
            const gridX = n.gridX !== undefined ? n.gridX : 9; const gridY = n.gridY !== undefined ? n.gridY : 9;
            const stoneClass = n.stoneColor === 'black' ? 'stone-black' : 'stone-white';
            const leftPct = (gridX / 18) * 100; const topPct = (gridY / 18) * 100;
            return `
            <div class="matrix-node ${stoneClass}" data-id="${n.id}" style="left:${leftPct}%; top:${topPct}%;">
                <div class="node-stone"></div>
                <div class="node-paper">
                    ${getTagHtml(n.tag)}
                    <div class="matrix-node-text">${this.entries.escapeHtml(n.text)}</div>
                    <div class="node-action-group">
                        <button class="node-action-btn" onclick="app.actions.toggleStoneColor('${n.id}')" title="標記警戒">☯️</button>
                        <button class="node-action-btn" onclick="app.actions.promoteToCard('${n.id}')" title="轉為排程卡片">📄</button>
                        <button class="node-action-btn del" style="color:#ef4444;" onclick="app.actions.deleteMatrixNode('${n.id}')" title="刪除">×</button>
                    </div>
                </div>
            </div>`
        }).join('');
        document.getElementById('matrix-grid-lines').innerHTML = html;
    },

    renderChronicle() {
        const target = document.getElementById('chronicle-render-target');
        if (!target) return;
        const esc = app.entries.escapeHtml.bind(app.entries);
        const filters = this.state.chronicleFilters || (this.state.chronicleFilters = { scope: 'all', project: '' });
        const NO_PROJECT = '__NO_PROJECT__';
        const today = this.worktime.localDateString();
        const currentMonth = today.slice(0, 7);

        let cards = [];
        for (const tabId in this.state.workspaces) {
            const tabName = this.state.tabs.find(t => t.id === tabId)?.name || '未知';
            (this.state.workspaces[tabId] || []).forEach(card => {
                if (!card.chroniclePinned) return;
                const fallbackDate = card.actualEnd || card.actualStart ||
                    (card.dateMode === 'range' ? (card.dateEnd || card.dateStart) : card.dateSingle) || '';
                cards.push({ ...card, tabId, tabName, chronicleResolvedDate: card.chronicleDate || fallbackDate });
            });
        }

        const projects = [...new Set(cards.map(c => (c.project || '').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'zh-Hant'));
        const hasNoProject = cards.some(c => !(c.project || '').trim());
        const projectOptions = [
            `<option value="">全部專案</option>`,
            ...(hasNoProject ? [`<option value="${NO_PROJECT}" ${filters.project === NO_PROJECT ? 'selected' : ''}>未分類</option>`] : []),
            ...projects.map(p => `<option value="${esc(p)}" ${filters.project === p ? 'selected' : ''}>${esc(p)}</option>`)
        ].join('');

        let filtered = cards.filter(c => {
            if (filters.scope === 'current' && String(c.chronicleResolvedDate || '').slice(0,7) !== currentMonth) return false;
            if (filters.project === NO_PROJECT && (c.project || '').trim()) return false;
            if (filters.project && filters.project !== NO_PROJECT && c.project !== filters.project) return false;
            return true;
        });
        filtered.sort((a,b) => String(a.chronicleResolvedDate || '9999-99-99').localeCompare(String(b.chronicleResolvedDate || '9999-99-99')) || String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hant'));

        const toolbar = `
            <div class="chronicle-toolbar">
                <div class="chronicle-scope-group" role="group" aria-label="大事記時間範圍">
                    <button class="chronicle-filter-btn ${filters.scope === 'all' ? 'active' : ''}" onclick="app.setChronicleFilter('scope','all')">全部</button>
                    <button class="chronicle-filter-btn ${filters.scope === 'current' ? 'active' : ''}" onclick="app.setChronicleFilter('scope','current')">本月</button>
                </div>
                <label class="chronicle-project-filter">
                    <span>專案</span>
                    <select onchange="app.setChronicleFilter('project',this.value)">${projectOptions}</select>
                </label>
                <span class="chronicle-count">${filtered.length} / ${cards.length} 筆</span>
            </div>`;

        if (!cards.length) {
            target.innerHTML = `${toolbar}<div class="chronicle-empty">
                <div class="chronicle-empty-icon">☆</div>
                <strong>大事記目前是空的</strong>
                <p>回到時間軸或看板，按卡片右上角的 ☆，只把真正值得回顧的成果、決定或節點加入這裡。</p>
            </div>`;
            return;
        }

        if (!filtered.length) {
            target.innerHTML = `${toolbar}<div class="chronicle-empty"><strong>目前篩選條件沒有大事記。</strong><p>資料沒有消失，只是被篩掉了。這次不是軟體在偷偷吃資料。</p></div>`;
            return;
        }

        const monthGroups = {};
        filtered.forEach(c => {
            const key = c.chronicleResolvedDate ? c.chronicleResolvedDate.slice(0,7) : '未設定日期';
            if (!monthGroups[key]) monthGroups[key] = [];
            monthGroups[key].push(c);
        });

        const content = Object.entries(monthGroups).map(([month, items]) => {
            const monthLabel = month === '未設定日期' ? month : `${month.replace('-', ' / ')}`;
            const rows = items.map(c => {
                const dateValue = c.chronicleResolvedDate || '';
                const project = (c.project || '').trim() || '未分類';
                const summary = c.chronicleSummary || '';
                const colorCfg = this.worktime.colorConfig(c.color);
                return `<article class="chronicle-card" style="--chronicle-accent:${colorCfg.hex};">
                    <div class="chronicle-card-date">
                        <input type="date" value="${esc(dateValue)}" aria-label="大事記日期" onchange="app.actions.updateChronicleMeta('${c.id}','chronicleDate',this.value,'${c.tabId}')">
                    </div>
                    <div class="chronicle-card-main">
                        <div class="chronicle-card-topline">
                            <div class="chronicle-card-title-wrap">
                                <span class="chronicle-project-tag">#${esc(project)}</span>
                                <span class="chronicle-tab-tag">${esc(c.tabName)}</span>
                                <strong class="chronicle-card-title">${esc(c.title || '未命名')}</strong>
                            </div>
                            <div class="chronicle-card-actions">
                                <button class="worklog-action-btn" onclick="app.actions.jumpToCard('${c.id}','${c.tabId}')">↗ 回原卡片</button>
                                <button class="worklog-action-btn danger" onclick="app.actions.toggleChronicle('${c.id}','${c.tabId}')">☆ 移出</button>
                            </div>
                        </div>
                        <label class="chronicle-summary-label">
                            <span>成果／事件摘要</span>
                            <textarea class="chronicle-summary-input" placeholder="例如：完成批次插入測試，主要流程已可運作。" oninput="app.actions.updateChronicleMeta('${c.id}','chronicleSummary',this.value,'${c.tabId}')">${esc(summary)}</textarea>
                        </label>
                    </div>
                </article>`;
            }).join('');
            return `<section class="chronicle-month-group"><h4>${esc(monthLabel)}</h4>${rows}</section>`;
        }).join('');

        target.innerHTML = toolbar + content;
    },

    renderGantt() {
        const esc = app.entries.escapeHtml.bind(app.entries);
        const target = document.getElementById('gantt-render-target');
        const projectSelect = document.getElementById('gantt-project-filter');
        const monthSelect = document.getElementById('gantt-month-filter');
        if (!app.state.ganttFilters) app.state.ganttFilters = { project:'', month:'', mode:'schedule', scale:'' };
        if (!app.state.ganttFilters.mode) app.state.ganttFilters.mode = 'schedule';
        const filters = app.state.ganttFilters;
        const mode = filters.mode === 'time' ? 'time' : 'schedule';
        const scale = this.worktime.getGanttScale();
        const scaleLabel = this.worktime.ganttScaleLabel(scale);
        const NO_PROJECT = '__NO_PROJECT__';

        const scheduleEntries = this.worktime.ganttCards();
        const timeEntries = this.worktime.allCards().filter(({card}) => {
            if (card.excludeFromGantt) return false;
            const hasLogs = this.worktime.getLogs(card).some(log => this.worktime.logMinutes(log) > 0 && log.workDate);
            const hasPlan = !card.isMemo && card.dateMode === 'range' && card.dateStart && card.dateEnd;
            return hasLogs || hasPlan;
        });
        const sourceEntries = (mode === 'time' ? timeEntries : scheduleEntries).sort((a,b) => {
            const ga = `${a.card.project || '未分類'}\u0000${a.card.category || '未分類'}`;
            const gb = `${b.card.project || '未分類'}\u0000${b.card.category || '未分類'}`;
            const ad = a.card.dateStart || this.worktime.derivedActualStart(a.card) || '';
            const bd = b.card.dateStart || this.worktime.derivedActualStart(b.card) || '';
            return ga.localeCompare(gb) || String(ad).localeCompare(String(bd));
        });

        document.querySelectorAll('[data-gantt-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.ganttMode === mode));
        document.querySelectorAll('[data-gantt-scale]').forEach(btn => btn.classList.toggle('active', btn.dataset.ganttScale === scale));

        const projects = [...new Set(sourceEntries.map(({card}) => card.project?.trim() ? String(card.project || '').trim() : NO_PROJECT))]
            .sort((a,b) => (a === NO_PROJECT ? '未分類專案' : a).localeCompare(b === NO_PROJECT ? '未分類專案' : b, 'zh-Hant'));
        if (filters.project && !projects.includes(filters.project)) filters.project = '';
        if (projectSelect) {
            projectSelect.innerHTML = `<option value="">全部專案</option>` + projects.map(p =>
                `<option value="${esc(p)}">${esc(p === NO_PROJECT ? '未分類專案' : p)}</option>`
            ).join('');
            projectSelect.value = filters.project || '';
        }

        const monthSet = new Set();
        sourceEntries.forEach(({card}) => {
            const s = this.worktime.parseLocalDate(card.dateStart);
            const e = this.worktime.parseLocalDate(card.dateEnd);
            if (s && e) {
                let cursor = new Date(s.getFullYear(), s.getMonth(), 1);
                const endMonth = new Date(e.getFullYear(), e.getMonth(), 1);
                let guard = 0;
                while (cursor <= endMonth && guard < 240) {
                    monthSet.add(`${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}`);
                    cursor = new Date(cursor.getFullYear(), cursor.getMonth()+1, 1);
                    guard++;
                }
            }
            this.worktime.getLogs(card).forEach(log => {
                if (/^\d{4}-\d{2}-\d{2}$/.test(log.workDate || '')) monthSet.add(log.workDate.slice(0,7));
            });
        });
        const months = [...monthSet].sort();
        if (filters.month && !months.includes(filters.month)) filters.month = '';
        if (monthSelect) {
            monthSelect.innerHTML = `<option value="">全部月份</option>` + months.map(m => {
                const [y, mo] = m.split('-');
                return `<option value="${m}">${Number(y)} 年 ${Number(mo)} 月</option>`;
            }).join('');
            monthSelect.value = filters.month || '';
        }

        let entries = sourceEntries.filter(({card}) => {
            const projectKey = card.project?.trim() ? String(card.project || '').trim() : NO_PROJECT;
            if (filters.project && projectKey !== filters.project) return false;
            if (!filters.month) return true;
            const [y, m] = filters.month.split('-').map(Number);
            const monthStart = new Date(y, m - 1, 1);
            const monthEnd = new Date(y, m, 0);
            const start = this.worktime.parseLocalDate(card.dateStart);
            const end = this.worktime.parseLocalDate(card.dateEnd);
            const planIntersects = !!(start && end && !(end < monthStart || start > monthEnd));
            const hasWorkInMonth = this.worktime.getLogs(card).some(log => (log.workDate || '').slice(0,7) === filters.month && this.worktime.logMinutes(log) > 0);
            return mode === 'time' ? (planIntersects || hasWorkInMonth) : planIntersects;
        });

        if (!sourceEntries.length) {
            target.innerHTML = mode === 'time'
                ? '<p style="text-align:center; color:#94a3b8; padding:25px;">目前沒有可顯示的排程或工時紀錄。先在卡片補登工時，或用心流計時停止後自動寫入。</p>'
                : '<p style="text-align:center; color:#94a3b8; padding:25px;">目前沒有可繪製的排程工項。將卡片用途設為「排程工項」，並填入預計開始與預計完成即可。</p>';
            return;
        }
        if (!entries.length) {
            target.innerHTML = '<p style="text-align:center; color:#94a3b8; padding:25px;">目前篩選條件下沒有資料。可以切換月份／專案或清除篩選。</p>';
            return;
        }

        let minDate, maxDate;
        if (filters.month) {
            const [y, m] = filters.month.split('-').map(Number);
            minDate = new Date(y, m - 1, 1);
            maxDate = new Date(y, m, 0);
        } else {
            const dateCandidates = [];
            entries.forEach(({card}) => {
                const s = this.worktime.parseLocalDate(card.dateStart);
                const e = this.worktime.parseLocalDate(card.dateEnd);
                if (s) dateCandidates.push(s);
                if (e) dateCandidates.push(e);
                if (mode === 'time') {
                    this.worktime.getLogs(card).forEach(log => {
                        const d = this.worktime.parseLocalDate(log.workDate);
                        if (d) dateCandidates.push(d);
                    });
                }
            });
            if (!dateCandidates.length) {
                target.innerHTML = '<p style="text-align:center; color:#94a3b8; padding:25px;">目前資料沒有有效日期。</p>';
                return;
            }
            minDate = new Date(Math.min(...dateCandidates.map(d => d.getTime())));
            maxDate = new Date(Math.max(...dateCandidates.map(d => d.getTime())));
            if (scale === 'week') {
                minDate = this.worktime.startOfWeek(minDate);
                maxDate = this.worktime.endOfWeek(maxDate);
            } else if (scale === 'month') {
                minDate = this.worktime.startOfMonth(minDate);
                maxDate = this.worktime.endOfMonth(maxDate);
            }
        }

        const periods = this.worktime.buildGanttPeriods(minDate, maxDate, scale);
        if (!periods.length) {
            target.innerHTML = '<p style="text-align:center; color:#94a3b8; padding:25px;">目前資料沒有可顯示的日期區間。</p>';
            return;
        }
        const lastPeriod = periods[periods.length - 1];
        const displayedMaxDate = lastPeriod.end;
        const expectedLastKey = this.worktime.dateKey(maxDate);
        const truncated = this.worktime.dateKey(displayedMaxDate) < expectedLastKey;
        const today = new Date();
        today.setHours(0,0,0,0);
        const leftCols = 7;
        const totalCols = leftCols + periods.length;

        let groupCells = '<th class="gantt-left gantt-title-col gantt-month-head">工項</th>' +
            '<th class="gantt-left gantt-status-col gantt-month-head">狀態</th>' +
            '<th class="gantt-left gantt-progress-col gantt-month-head">完成度</th>' +
            '<th class="gantt-left gantt-hours-col gantt-month-head">工時<br><span style="font-weight:normal;font-size:.7rem;">已用 / 預估 / 尚餘</span></th>' +
            '<th class="gantt-left gantt-plan-col gantt-month-head">規劃<br><span style="font-weight:normal;font-size:.7rem;">預計開始 → 完成</span></th>' +
            '<th class="gantt-left gantt-actual-col gantt-month-head">實際<br><span style="font-weight:normal;font-size:.7rem;">實際開始 → 完成</span></th>' +
            '<th class="gantt-left gantt-track-col gantt-month-head">軌道</th>';
        let gi = 0;
        while (gi < periods.length) {
            let gj = gi + 1;
            while (gj < periods.length && periods[gj].groupLabel === periods[gi].groupLabel) gj++;
            groupCells += `<th class="gantt-month-head" colspan="${gj-gi}">${esc(periods[gi].groupLabel)}</th>`;
            gi = gj;
        }

        const periodCells = '<th class="gantt-left gantt-title-col">名稱</th>' +
            '<th class="gantt-left gantt-status-col">狀態</th>' +
            '<th class="gantt-left gantt-progress-col">成果</th>' +
            '<th class="gantt-left gantt-hours-col">工時</th>' +
            '<th class="gantt-left gantt-plan-col">預計</th>' +
            '<th class="gantt-left gantt-actual-col">實際</th>' +
            '<th class="gantt-left gantt-track-col">層</th>' +
            periods.map(period => {
                const containsToday = today >= period.start && today <= period.end;
                const fullTitle = period.start.getTime() === period.end.getTime()
                    ? this.worktime.dateKey(period.start)
                    : `${this.worktime.dateKey(period.start)} ～ ${this.worktime.dateKey(period.end)}`;
                return `<th class="gantt-day-head ${containsToday ? 'today-col' : ''}" title="${esc(fullTitle)}">${esc(period.label)}</th>`;
            }).join('');

        const totalPlanned = entries.reduce((sum, {card}) => sum + this.worktime.plannedMinutes(card), 0);
        const totalActual = entries.reduce((sum, {card}) => sum + this.worktime.totalMinutes(card), 0);
        const totalRemaining = entries.reduce((sum, {card}) => {
            const remaining = this.worktime.remainingPlannedMinutes(card);
            return sum + (remaining === null ? 0 : remaining);
        }, 0);
        const remainingSummary = totalPlanned
            ? (totalRemaining >= 0 ? `依原預估尚餘 ${this.worktime.formatMinutes(totalRemaining)}` : `已超出預估 ${this.worktime.formatMinutes(Math.abs(totalRemaining))}`)
            : '尚未設定總預估工時';
        const conflictTaskCount = entries.filter(({card}) => this.worktime.scheduleConflicts(card).length > 0).length;
        const summary = `<div class="gantt-summary-strip">
            <span><strong>${entries.length}</strong> 筆工項</span>
            <span>預估 <strong>${totalPlanned ? this.worktime.formatMinutes(totalPlanned) : '未估'}</strong></span>
            <span>實際 <strong>${this.worktime.formatMinutes(totalActual)}</strong></span>
            <span class="${totalRemaining < 0 ? 'over' : ''}">${esc(remainingSummary)}</span>
            ${conflictTaskCount ? `<span class="gantt-conflict-summary">⚠ <strong>${conflictTaskCount}</strong> 筆可見工項有排程重疊</span>` : '<span class="gantt-conflict-ok">✓ 無可見工項排程重疊</span>'}
            <span>尺度 <strong>${scaleLabel}</strong></span>
        </div>`;

        // 每張卡的工時只掃一次，依日期分到對應的欄位（原本是每欄都掃全部工時）。
        const periodStarts = periods.map(p => p.start.getTime());
        const periodIndexOf = (d) => {
            const t = d.getTime();
            let lo = 0, hi = periods.length - 1, ans = -1;
            while (lo <= hi) { const mid = (lo + hi) >> 1; if (periodStarts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
            if (ans < 0 || t > periods[ans].end.getTime()) return -1;
            return ans;
        };

        let body = '';
        let lastGroup = null;
        entries.forEach(({card, tabId, tabName}) => {
            const project = card.project || '未分類專案';
            const category = card.category || '未分類';
            const group = `${project} / ${category}`;
            if (group !== lastGroup) {
                body += `<tr class="gantt-group-row"><td colspan="${totalCols}">${esc(project)} <span style="color:#94a3b8;">/</span> ${esc(category)}</td></tr>`;
                lastGroup = group;
            }

            const start = this.worktime.parseLocalDate(card.dateStart);
            const end = this.worktime.parseLocalDate(card.dateEnd);
            const progress = this.worktime.progressValue(card);
            const planned = this.worktime.plannedMinutes(card);
            const actual = this.worktime.totalMinutes(card);
            const remaining = this.worktime.remainingPlannedMinutes(card);
            const usagePct = this.worktime.workUsagePercent(card);
            const actualStart = this.worktime.derivedActualStart(card);
            const actualEnd = this.worktime.derivedActualEnd(card);
            const cfg = this.worktime.colorConfig(card.color);
            const status = this.worktime.statusLabel(card.status);
            const actualText = actualStart ? `${actualStart}${actualEnd ? ` → ${actualEnd}` : ' → …'}` : (actual > 0 ? '已有工時紀錄' : '尚未開始');
            const logs = this.worktime.getLogs(card);
            const conflicts = this.worktime.scheduleConflicts(card);
            const conflictTitle = conflicts.length ? conflicts.map(item => `${item.overlapStart}${item.overlapEnd !== item.overlapStart ? `～${item.overlapEnd}` : ''} ${item.card.title || '未命名'}${item.hiddenFromGantt ? '（甘特隱藏）' : ''}`).join('；') : '';
            const conflictBadge = conflicts.length ? `<span class="gantt-conflict-badge" title="${esc(conflictTitle)}">⚠ ${conflicts.length}</span>` : '';

            const progressHtml = `<div class="gantt-progress-value">${progress}%</div><div class="gantt-mini-track"><span style="width:${Math.max(0, Math.min(100, progress))}%;"></span></div>`;
            let remainingText = '未設定預估';
            if (remaining !== null) remainingText = remaining >= 0 ? `尚餘約 ${this.worktime.formatMinutes(remaining)}` : `超出 ${this.worktime.formatMinutes(Math.abs(remaining))}`;
            const usageWidth = usagePct === null ? 0 : Math.max(0, Math.min(100, usagePct));
            const hoursHtml = `<div class="gantt-hours-main">已用 <strong>${this.worktime.formatMinutes(actual)}</strong>${planned ? ` / 預估 ${this.worktime.formatMinutes(planned)}` : ' / 未估'}</div>
                <div class="gantt-hours-remain ${remaining !== null && remaining < 0 ? 'over' : ''}">${esc(remainingText)}</div>
                ${planned ? `<div class="gantt-usage-track"><span class="${usagePct > 100 ? 'over' : ''}" style="width:${usageWidth}%;"></span></div>` : ''}
                ${Number(card.status) === 1 && actual <= 0 ? '<div class="gantt-unlogged">⚠ 進行中但尚無工時紀錄</div>' : ''}`;
            const planText = start && end ? `${card.dateStart} → ${card.dateEnd}` : '無排程';

            const planPeriodRow = periods.map(period => {
                const containsToday = today >= period.start && today <= period.end;
                const intersects = !!(start && end && !(end < period.start || start > period.end));
                if (!intersects) return `<td class="gantt-day-cell ${containsToday ? 'today-col' : ''}"></td>`;
                const periodText = period.start.getTime() === period.end.getTime()
                    ? this.worktime.dateKey(period.start)
                    : `${this.worktime.dateKey(period.start)} ～ ${this.worktime.dateKey(period.end)}`;
                const title = esc(`${card.title || '未命名'}｜${periodText}｜預計排程有涵蓋`);
                const isStart = !!(start && start >= period.start && start <= period.end) || (start && start < minDate && period.start.getTime() === minDate.getTime());
                const isEnd = !!(end && end >= period.start && end <= period.end) || (end && end > displayedMaxDate && period.end.getTime() === displayedMaxDate.getTime());
                return `<td class="gantt-day-cell gantt-bar-cell ${isStart ? 'gantt-bar-start' : ''} ${isEnd ? 'gantt-bar-end' : ''} ${containsToday ? 'today-col' : ''}" style="background:${cfg.light};" title="${title}"></td>`;
            }).join('');

            const buckets = new Map();
            logs.forEach(log => {
                const d = this.worktime.parseLocalDate(log.workDate);
                const mins = this.worktime.logMinutes(log);
                if (!d || mins <= 0) return;
                const idx = periodIndexOf(d);
                if (idx < 0) return;
                const b = buckets.get(idx) || { mins: 0, count: 0, outside: 0 };
                b.mins += mins; b.count++;
                if (start && end && (d < start || d > end)) b.outside++;
                buckets.set(idx, b);
            });
            const actualPeriodRow = periods.map((period, idx) => {
                const containsToday = today >= period.start && today <= period.end;
                const b = buckets.get(idx);
                if (!b) return `<td class="gantt-day-cell ${containsToday ? 'today-col' : ''}"></td>`;
                const periodText = period.start.getTime() === period.end.getTime()
                    ? this.worktime.dateKey(period.start)
                    : `${this.worktime.dateKey(period.start)} ～ ${this.worktime.dateKey(period.end)}`;
                const titleParts = [`${card.title || '未命名'}｜${periodText}`, `實際 ${this.worktime.formatMinutes(b.mins)}（${b.count} 筆）`];
                if (b.outside > 0) titleParts.push(`⚠ ${b.outside} 筆排程外工時`);
                return `<td class="gantt-day-cell gantt-work-cell ${b.outside > 0 ? 'gantt-work-outside' : ''} ${containsToday ? 'today-col' : ''}" style="background:${cfg.hex};" title="${esc(titleParts.join('｜'))}"><span>${esc(this.worktime.compactMinutes(b.mins))}</span></td>`;
            }).join('');

            body += `
                <tr class="gantt-plan-row ${mode === 'time' ? 'gantt-time-focus' : ''}" style="cursor:pointer;" onclick="app.actions.jumpToCard('${card.id}','${tabId}')" title="點擊跳回卡片">
                    <td rowspan="2" class="gantt-left gantt-title-col gantt-rowspan-cell">
                        <div class="gantt-task-title"><span class="color-chip" style="background:${cfg.hex}"></span><span>${esc(card.title || '未命名')}</span>${conflictBadge}</div>
                        <div style="font-size:.68rem;color:#94a3b8;margin-top:2px;">[${esc(tabName)}]${card.isMemo ? ' · 自由卡' : ''}</div>
                    </td>
                    <td rowspan="2" class="gantt-left gantt-status-col gantt-rowspan-cell">${esc(status)}</td>
                    <td rowspan="2" class="gantt-left gantt-progress-col gantt-rowspan-cell">${progressHtml}</td>
                    <td rowspan="2" class="gantt-left gantt-hours-col gantt-rowspan-cell">${hoursHtml}</td>
                    <td rowspan="2" class="gantt-left gantt-plan-col gantt-rowspan-cell">${esc(planText)}</td>
                    <td rowspan="2" class="gantt-left gantt-actual-col gantt-rowspan-cell">${esc(actualText)}</td>
                    <td class="gantt-left gantt-track-col gantt-track-plan">📐 預計</td>
                    ${planPeriodRow}
                </tr>
                <tr class="gantt-actual-row" style="cursor:pointer;" onclick="app.actions.jumpToCard('${card.id}','${tabId}')" title="點擊跳回卡片">
                    <td class="gantt-left gantt-track-col gantt-track-actual">⏱️ 實際</td>
                    ${actualPeriodRow}
                </tr>`;
        });

        const capText = scale === 'day' ? '366 天' : (scale === 'week' ? '156 週' : '120 個月');
        const warning = truncated ? `<div style="margin-bottom:8px;color:#b45309;font-size:.8rem;">⚠️ 顯示跨度過長，${scaleLabel}尺度最多顯示 ${capText}；原始資料與 Excel 工項／工時明細不受影響。</div>` : '';
        const filterNote = (filters.project || filters.month)
            ? `<div style="margin-bottom:8px;color:#475569;font-size:.8rem;">目前顯示 ${entries.length} 筆${filters.project ? ` · 專案：${esc(filters.project === NO_PROJECT ? '未分類專案' : filters.project)}` : ''}${filters.month ? ` · 月份：${esc(filters.month)}` : ''} · 尺度：${scaleLabel}</div>`
            : '';
        const granularity = scale === 'day' ? '每天' : (scale === 'week' ? '每週' : '每月');
        const modeNote = mode === 'time'
            ? `<div class="gantt-mode-note">⏱️ 工時模式：下層實際工時依「${scaleLabel}」尺度彙總（${granularity}）；上層預計排程淡化。切換尺度只改顯示，不改原始工時日期。</div>`
            : `<div class="gantt-mode-note">📅 排程模式：上層顯示預計排程，下層顯示${granularity}實際投入。日／週／月只是檢視尺度，不會改寫卡片資料；設定為「不顯示於甘特」的卡片不會出現在此圖，但正式排程仍會參與重疊提醒。</div>`;
        target.innerHTML = `${filterNote}${warning}${summary}${modeNote}<div class="gantt-table-wrap"><table class="gantt-table gantt-scale-${scale}"><thead><tr>${groupCells}</tr><tr>${periodCells}</tr></thead><tbody>${body}</tbody></table></div>`;
    },

    renderCalendar() {
        let allCards = []; 
        for (let tabId in this.state.workspaces) { 
            const tabName = this.state.tabs.find(t => t.id === tabId)?.name || '未知'; 
            this.state.workspaces[tabId].forEach(c => allCards.push({ ...c, tabId, tabName })); 
        }
        allCards = allCards.filter(c => !c.isMemo && (c.dateSingle || c.dateStart));
        if (allCards.length === 0) { document.getElementById('calendar-render-target').innerHTML = '<p style="text-align:center; color:#94a3b8;">全部分頁中皆無有效日期資料</p>'; return; }
        
        const grouped = {}; allCards.forEach(c => { const d = c.dateMode === 'range' ? c.dateStart : c.dateSingle; if(d) { if(!grouped[d]) grouped[d] = []; grouped[d].push(c); } });
        let html = '<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap:15px;">';
        
        Object.keys(grouped).sort().forEach(dateStr => { 
            html += `<div style="border:1px solid #e2e8f0; border-radius:8px; padding:12px; background:#f8fafc; box-shadow: 0 2px 4px rgba(0,0,0,0.02);">
                        <div style="font-weight:bold; color:var(--primary); border-bottom:1px solid #cbd5e1; margin-bottom:10px; padding-bottom:6px; font-size:1.1rem;">${dateStr}</div>`; 
            grouped[dateStr].forEach(c => { 
                const cardBorderColor = c.color === 'blue' ? '#3b82f6' : (c.color === 'red' ? '#ef4444' : (c.color === 'yellow' ? '#f59e0b' : '#10b981'));
                html += `
                <div style="font-size:0.9rem; background:white; padding:6px 10px; border-radius:6px; margin-bottom:6px; box-shadow:0 1px 3px rgba(0,0,0,0.05); border-left:4px solid ${cardBorderColor}; cursor:pointer; position:relative; display:flex; justify-content:space-between; align-items:center;" 
                     onclick="app.actions.jumpToCard('${c.id}', '${c.tabId}')" title="點擊跳轉至時間軸">
                    <div>
                        <div style="color:#64748b; font-size:0.75rem; margin-bottom:2px; font-weight:bold;">${this.entries.escapeHtml(c.tabName)}</div>
                        <div style="color:#1e293b;">${this.entries.escapeHtml(c.title || '未命名')}</div>
                    </div>
                    <button class="icon-btn" onclick="event.stopPropagation(); app.actions.deleteCard('${c.id}', '${c.tabId}')" style="color:#ef4444; border:none; background:transparent; padding:0; width:24px; height:24px;" title="刪除此卡片">🗑️</button>
                </div>`; 
            }); 
            html += `</div>`; 
        });
        document.getElementById('calendar-render-target').innerHTML = html + '</div>';
    },

    renderNotebookArea() {
        const d = this.state.globalNotebook; let html = '';
        if (d.template === 'free') { html = `<textarea class="nb-textarea" oninput="app.actions.updateNotebook('free', this.value)" placeholder="在這裡傾倒您的思緒...">${this.entries.escapeHtml(d.free || '')}</textarea>`; } 
        else if (d.template === 'matrix') { const m = d.matrix || {}; html = `<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap:15px;"><div style="background:#fef2f2; padding:15px; border-radius:8px; border:1px solid #fca5a5;"><span style="color:#ef4444; font-weight:bold; font-size:1.1rem; display:block; margin-bottom:10px;">🔥 重要・緊急</span><textarea class="nb-textarea" style="height:150px; background:white;" oninput="app.actions.updateNotebook('matrix.q1', this.value)">${this.entries.escapeHtml(m.q1 || '')}</textarea></div><div style="background:#eff6ff; padding:15px; border-radius:8px; border:1px solid #bfdbfe;"><span style="color:#3b82f6; font-weight:bold; font-size:1.1rem; display:block; margin-bottom:10px;">📅 重要・不急</span><textarea class="nb-textarea" style="height:150px; background:white;" oninput="app.actions.updateNotebook('matrix.q2', this.value)">${this.entries.escapeHtml(m.q2 || '')}</textarea></div><div style="background:#fffbeb; padding:15px; border-radius:8px; border:1px solid #fde68a;"><span style="color:#f59e0b; font-weight:bold; font-size:1.1rem; display:block; margin-bottom:10px;">⚡ 緊急・不重</span><textarea class="nb-textarea" style="height:150px; background:white;" oninput="app.actions.updateNotebook('matrix.q3', this.value)">${this.entries.escapeHtml(m.q3 || '')}</textarea></div><div style="background:#f0fdf4; padding:15px; border-radius:8px; border:1px solid #bbf7d0;"><span style="color:#10b981; font-weight:bold; font-size:1.1rem; display:block; margin-bottom:10px;">☕ 不重・不急</span><textarea class="nb-textarea" style="height:150px; background:white;" oninput="app.actions.updateNotebook('matrix.q4', this.value)">${this.entries.escapeHtml(m.q4 || '')}</textarea></div></div>`; }
        document.getElementById('notebook-render-target').innerHTML = html;
    },

    renderTsumegoStones() {
        let html = ''; const starPositions = [3, 9, 15];
        starPositions.forEach(x => { starPositions.forEach(y => { html += `<div class="star-point" style="left: ${(x/18)*100}%; top: ${(y/18)*100}%;"></div>`; }); });
        html += this.state.tsumego.stones.map(s => { const left = (s.x / 18) * 100; const top = (s.y / 18) * 100; return `<div class="pure-stone ${s.color}" style="left:${left}%; top:${top}%;"></div>`; }).join('');
        document.getElementById('tsumego-grid-lines').innerHTML = html;
    },

    injectStarPoints() {
        const starPositions = [3, 9, 15]; let html = '';
        starPositions.forEach(x => { starPositions.forEach(y => { html += `<div class="star-point" style="left: ${(x / 18) * 100}%; top: ${(y / 18) * 100}%;"></div>`; }); });
        document.getElementById('matrix-grid-lines').innerHTML = html;
        document.getElementById('tsumego-grid-lines').innerHTML = html;
    },

    // ==========================================
    // 拖曳互動邏輯 (發想矩陣 & 詰棋視窗)
    // ==========================================
    dragState: { isDragging: false, nodeId: null, offsetX: 0, offsetY: 0 },
    setupMatrixDrag() {
        const gridLinesContainer = document.getElementById('matrix-grid-lines');
        const startDrag = (e) => {
            const nodeEl = e.target.closest('.matrix-node');
            if (!nodeEl || e.target.closest('button')) return;
            app.dragState.isDragging = true; app.dragState.nodeId = nodeEl.dataset.id;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX; const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const gridRect = gridLinesContainer.getBoundingClientRect();
            const currentPctX = parseFloat(nodeEl.style.left) / 100; const currentPctY = parseFloat(nodeEl.style.top) / 100;
            const stoneCenterX = gridRect.left + (gridRect.width * currentPctX); const stoneCenterY = gridRect.top + (gridRect.height * currentPctY);
            app.dragState.offsetX = clientX - stoneCenterX; app.dragState.offsetY = clientY - stoneCenterY;
        };
        const onDrag = (e) => {
            if (!app.dragState.isDragging) return; e.preventDefault(); 
            const clientX = e.touches ? e.touches[0].clientX : e.clientX; const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const gridRect = gridLinesContainer.getBoundingClientRect();
            let x = clientX - gridRect.left - app.dragState.offsetX; let y = clientY - gridRect.top - app.dragState.offsetY;
            let pctX = (x / gridRect.width) * 100; let pctY = (y / gridRect.height) * 100;
            const nodeEl = document.querySelector(`.matrix-node[data-id="${app.dragState.nodeId}"]`);
            nodeEl.style.transition = 'none'; nodeEl.style.left = pctX + '%'; nodeEl.style.top = pctY + '%';
        };
        const endDrag = (e) => {
            if (!app.dragState.isDragging) return; app.dragState.isDragging = false;
            const nodeEl = document.querySelector(`.matrix-node[data-id="${app.dragState.nodeId}"]`);
            if(!nodeEl) return;
            let pctX = parseFloat(nodeEl.style.left); let pctY = parseFloat(nodeEl.style.top);
            let gridX = Math.round((pctX / 100) * 18); let gridY = Math.round((pctY / 100) * 18);
            gridX = Math.max(0, Math.min(18, gridX)); gridY = Math.max(0, Math.min(18, gridY));
            app.actions.updateMatrixNodePos(app.dragState.nodeId, gridX, gridY);
        };
        const board = document.getElementById('matrix-board');
        board.addEventListener('mousedown', startDrag); board.addEventListener('touchstart', startDrag, { passive: false });
        document.addEventListener('mousemove', onDrag); document.addEventListener('touchmove', onDrag, { passive: false });
        document.addEventListener('mouseup', endDrag); document.addEventListener('touchend', endDrag);
    },

    setupTsumegoDrag() {
        const panel = document.getElementById('tsumego-panel'); const header = document.getElementById('tsumego-header');
        let isDragging = false, startX, startY, startLeft, startTop;
        const onMouseDown = (e) => {
            if (e.target.closest('button') || window.innerWidth <= 768) return;
            isDragging = true;
            startX = e.touches ? e.touches[0].clientX : e.clientX; startY = e.touches ? e.touches[0].clientY : e.clientY;
            startLeft = panel.offsetLeft; startTop = panel.offsetTop;
            panel.style.transform = 'none'; panel.style.left = startLeft + 'px'; panel.style.top = startTop + 'px';
        };
        const onMouseMove = (e) => {
            if (!isDragging) return; e.preventDefault();
            let dx = (e.touches ? e.touches[0].clientX : e.clientX) - startX; let dy = (e.touches ? e.touches[0].clientY : e.clientY) - startY;
            panel.style.left = startLeft + dx + 'px'; panel.style.top = startTop + dy + 'px';
        };
        const onMouseUp = () => { isDragging = false; };
        header.addEventListener('mousedown', onMouseDown); header.addEventListener('touchstart', onMouseDown, {passive: false});
        document.addEventListener('mousemove', onMouseMove); document.addEventListener('touchmove', onMouseMove, {passive: false});
        document.addEventListener('mouseup', onMouseUp); document.addEventListener('touchend', onMouseUp);
    },

    setFilter(type, value) { if (type === 'project') this.state.filters.activeProject = value; this.renderAll(); },
    setChronicleFilter(type, value) {
        if (!this.state.chronicleFilters) this.state.chronicleFilters = { scope: 'all', project: '' };
        if (type === 'scope') this.state.chronicleFilters.scope = value === 'current' ? 'current' : 'all';
        if (type === 'project') this.state.chronicleFilters.project = value || '';
        this.rememberPrefs();
        if (this.state.view === 'chronicle') this.renderChronicle();
    },

    // ==========================================
    // 基礎 Actions (增刪改查)
    // ==========================================
    // ==========================================
    // 📋 週報：本週完成／進行中／下週預計／卡住與需要誰幫忙
    // ==========================================
    report: {
        filters: { week: 0, scope: 'all', project: '' },

        range(offset = 0) {
            const W = app.worktime;
            const start = W.addDays(W.startOfWeek(new Date()), offset * 7);
            const end = W.addDays(start, 6);
            return { start, end, s: W.localDateString(start), e: W.localDateString(end) };
        },

        projectOf(card) { return String(card.project || '').trim() || '未分類'; },

        rows() {
            const all = app.worktime.allCards();
            const f = this.filters;
            return all.filter(({ card, tabId }) => {
                if (app.sync.isBlankCard(card)) return false;
                if (f.scope === 'current' && tabId !== app.state.activeTabId) return false;
                if (f.project && this.projectOf(card) !== f.project) return false;
                return true;
            });
        },

        collect() {
            const W = app.worktime;
            const wk = this.range(this.filters.week);
            const nx = this.range(this.filters.week + 1);
            const today = W.localDateString();
            const inRange = (d, r) => d && d >= r.s && d <= r.e;
            const overlaps = (card, r) => {
                const s = W.plannedStart(card), e = W.plannedEnd(card) || s;
                return !!s && !(e < r.s || s > r.e);
            };
            const out = { wk, nx, done: [], doing: [], next: [], waiting: [], overdue: [], minutes: 0 };
            this.rows().forEach(row => {
                const { card } = row;
                const mins = W.getLogs(card).reduce((sum, l) => inRange(l.workDate, wk) ? sum + W.logMinutes(l) : sum, 0);
                out.minutes += mins;
                const status = Number(card.status) || 0;
                const item = { ...row, mins };
                const isDone = status === 2 && inRange(W.derivedActualEnd(card), wk);
                if (isDone) out.done.push(item);
                else if (status !== 2 && (mins > 0 || (status === 1 && overlaps(card, wk)))) out.doing.push(item);
                if (status !== 2 && !card.isMemo && overlaps(card, nx)) out.next.push(item);
                if (status !== 2 && (String(card.waitingWho || '').trim() || String(card.waitingWhat || '').trim() || status === 3)) out.waiting.push(item);
                const pe = W.plannedEnd(card);
                if (status !== 2 && !card.isMemo && pe && pe < today && this.filters.week === 0) out.overdue.push(item);
            });
            const byProject = (a, b) => this.projectOf(a.card).localeCompare(this.projectOf(b.card), 'zh-Hant') || String(W.plannedEnd(a.card)).localeCompare(String(W.plannedEnd(b.card)));
            ['done', 'doing', 'next', 'waiting', 'overdue'].forEach(k => out[k].sort(byProject));
            return out;
        },

        line(kind, { card, mins }) {
            const W = app.worktime;
            const p = `[${this.projectOf(card)}] ${card.title || '未命名'}`;
            const d = String(card.deliverable || '').trim();
            const next = String(card.nextStep || '').trim();
            const s = W.plannedStart(card), e = W.plannedEnd(card);
            const dates = s ? (e && e !== s ? `${s.slice(5)}～${e.slice(5)}` : s.slice(5)) : '';
            if (kind === 'done') return `${p}${d ? ` — ${d}` : ''}`;
            if (kind === 'doing') return `${p}${card.progress !== undefined && card.progress !== '' ? `（${W.progressValue(card)}%）` : ''}${mins ? `，本週 ${W.formatMinutes(mins)}` : ''}${next ? ` → 下一步：${next}` : ''}`;
            if (kind === 'next') return `${p}${dates ? `（${dates}）` : ''}${next ? ` → ${next}` : ''}`;
            if (kind === 'waiting') {
                const who = String(card.waitingWho || '').trim(), what = String(card.waitingWhat || '').trim();
                return `${p}：等 ${who || '（未填）'}${what ? `（${what}）` : ''}${card.followUpDate ? ` · ${String(card.followUpDate || '').slice(5)} 追` : ''}`;
            }
            if (kind === 'overdue') return `${p}（原訂 ${W.plannedEnd(card).slice(5)} 完成）${next ? ` → ${next}` : ''}`;
            return p;
        },

        text(data = this.collect()) {
            const W = app.worktime;
            const fmt = r => `${r.start.getMonth() + 1}/${r.start.getDate()}–${r.end.getMonth() + 1}/${r.end.getDate()}`;
            const sec = (title, kind, list, empty) => `■ ${title}\n${list.length ? list.map(x => `・${this.line(kind, x)}`).join('\n') : `・${empty}`}`;
            return [
                `【週報】${fmt(data.wk)}${this.filters.project ? `｜${this.filters.project}` : ''}`,
                sec('本週完成', 'done', data.done, '（無）'),
                sec('進行中', 'doing', data.doing, '（無）'),
                data.overdue.length ? sec('已過預計完成日', 'overdue', data.overdue, '') : '',
                sec('卡住／需要協助', 'waiting', data.waiting, '目前沒有'),
                sec(`下週預計（${fmt(data.nx)}）`, 'next', data.next, '（尚未排定）'),
                `本週投入工時：${W.formatMinutes(data.minutes)}`
            ].filter(Boolean).join('\n\n');
        },

        set(field, value) {
            if (field === 'week') this.filters.week = Number(value) || 0;
            if (field === 'scope') this.filters.scope = value === 'current' ? 'current' : 'all';
            if (field === 'project') this.filters.project = value || '';
            this.render();
        },

        render() {
            const target = document.getElementById('report-render-target');
            if (!target) return;
            const esc = s => app.entries.escapeHtml(s);
            const data = this.collect();
            const projects = [...new Set(app.worktime.allCards().filter(r => !app.sync.isBlankCard(r.card)).map(r => this.projectOf(r.card)))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
            const f = this.filters;
            const block = (icon, title, kind, list, hint) => `
                <section class="report-section report-${kind}">
                    <h4>${icon} ${title} <span class="data-count">${list.length}</span></h4>
                    ${list.length ? list.map(x => `<button type="button" class="report-row" onclick="app.actions.jumpToCard('${x.card.id}','${x.tabId}')">${esc(this.line(kind, x))}</button>`).join('') : `<div class="data-empty">${hint}</div>`}
                </section>`;
            target.innerHTML = `
                <div class="report-toolbar">
                    <div class="gantt-mode-switch">
                        <button class="gantt-mode-btn ${f.week === 0 ? 'active' : ''}" onclick="app.report.set('week',0)">本週</button>
                        <button class="gantt-mode-btn ${f.week === -1 ? 'active' : ''}" onclick="app.report.set('week',-1)">上週</button>
                    </div>
                    <select class="gantt-filter-select" onchange="app.report.set('scope',this.value)">
                        <option value="all" ${f.scope === 'all' ? 'selected' : ''}>全部工作區</option>
                        <option value="current" ${f.scope === 'current' ? 'selected' : ''}>只看目前工作區</option>
                    </select>
                    <select class="gantt-filter-select" onchange="app.report.set('project',this.value)">
                        <option value="">全部專案</option>
                        ${projects.map(p => `<option value="${esc(p)}" ${f.project === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
                    </select>
                    <span class="report-hours">本週投入 <b>${app.worktime.formatMinutes(data.minutes)}</b></span>
                </div>
                <div class="report-grid">
                    ${block('✅', '本週完成', 'done', data.done, '本週還沒有標記完成的卡片。')}
                    ${block('🚧', '進行中', 'doing', data.doing, '本週沒有記到工時的卡片。')}
                    ${data.overdue.length ? block('⚠️', '已過預計完成日', 'overdue', data.overdue, '') : ''}
                    ${block('⏳', '卡住／需要協助', 'waiting', data.waiting, '沒有在等別人的事。卡片「交付與進度」裡可以填「在等誰」。')}
                    ${block('📅', '下週預計', 'next', data.next, '下週還沒有排定的工作包。')}
                </div>
                ${app.journal.renderPanel()}
                <div class="report-text-wrap">
                    <div class="report-text-head">
                        <b>可以直接貼給主管或合作者的文字</b>
                        <span style="display:flex;gap:6px;flex-wrap:wrap;">
                            <button class="excel-copy-btn" onclick="app.report.copy()">📋 複製週報</button>
                            <button class="excel-copy-btn" onclick="app.coach.open({ template: 'status' })">🧑‍🏫 請 AI 改寫成進度報告</button>
                            <button class="excel-copy-btn" onclick="app.coach.open({ template: 'retro' })">🧑‍🏫 每週復盤</button>
                        </span>
                    </div>
                    <pre class="report-text">${esc(this.text(data))}</pre>
                </div>`;
        },

        copy() { app.worktime.copyText(this.text(), '已複製週報文字'); }
    },

    // ==========================================
    // 🗒 工作日誌：日期｜時間｜工時｜專案｜卡片｜內容（給公司填工時用）
    // 來源：工時紀錄（計時／補登）、卡片的工作紀錄、心流沙盒的「閃念」
    // ==========================================
    journal: {
        filters: { range: 'week', from: '', to: '', withNotes: true },

        range() {
            const W = app.worktime;
            const today = new Date();
            const f = this.filters;
            let s, e;
            if (f.range === 'lastweek') { s = W.addDays(W.startOfWeek(today), -7); e = W.addDays(s, 6); }
            else if (f.range === 'month') { s = W.startOfMonth(today); e = W.endOfMonth(today); }
            else if (f.range === 'lastmonth') { s = W.startOfMonth(new Date(today.getFullYear(), today.getMonth() - 1, 1)); e = W.endOfMonth(s); }
            else if (f.range === 'today') { s = new Date(today); e = new Date(today); }
            else if (f.range === 'custom' && W.parseLocalDate(f.from) && W.parseLocalDate(f.to)) { s = W.parseLocalDate(f.from); e = W.parseLocalDate(f.to); if (e < s) [s, e] = [e, s]; }
            else { s = W.startOfWeek(today); e = W.addDays(s, 6); }
            return { s: W.localDateString(s), e: W.localDateString(e) };
        },

        // 閃念：「**[10/30 09:12]** 內容」（舊格式只有時間、沒有日期的略過）
        quickNotes(card) {
            const out = [];
            const year = new Date().getFullYear();
            String(card.content || '').split('\n').forEach(line => {
                const m = line.match(/^\s*\*\*\[(\d{1,2})\/(\d{1,2})\s+(\d{2}:\d{2})\]\*\*\s*(.*)$/);
                if (!m) return;
                let y = year;
                const date = `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
                if (date > app.worktime.localDateString()) y -= 1; // 跨年：未來日期視為去年
                out.push({ date: `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`, time: m[3], text: m[4].trim() });
            });
            return out;
        },

        collect() {
            const W = app.worktime;
            const r = this.range();
            const inR = d => d && d >= r.s && d <= r.e;
            const rows = [];
            W.allCards().forEach(({ card, tabName }) => {
                const project = String(card.project || '').trim() || '未分類';
                const title = String(card.title || '').trim() || '未命名卡片';
                W.getLogs(card).forEach(log => {
                    if (!inR(log.workDate) || W.logMinutes(log) <= 0) return;
                    const range = W.logTimeRange(log);
                    rows.push({
                        kind: 'work', category: log.category || card.timeCategory || '', date: log.workDate, time: range, sortTime: range ? range.slice(0, 5) : '99:99',
                        minutes: W.logMinutes(log), project, title, tabName,
                        content: String(log.note || '').trim() || (log.source === 'timer' ? '心流計時' : '手動補登'),
                        source: log.source === 'timer' ? '計時' : '手動', cardId: card.id
                    });
                });
                if (!this.filters.withNotes) return;
                (card.entries || []).forEach(en => {
                    const d = en.createdAt ? new Date(en.createdAt) : null;
                    if (!d || Number.isNaN(d.getTime())) return;
                    const date = W.localDateString(d);
                    if (!inR(date)) return;
                    const text = [String(en.title || '').trim(), String(en.content || '').trim()].filter(Boolean).join('：');
                    rows.push({ kind: 'note', date, time: W.clock(d), sortTime: W.clock(d), minutes: 0, project, title, tabName, content: text || '（空白紀錄）', source: '工作紀錄', cardId: card.id });
                });
                this.quickNotes(card).forEach(q => {
                    if (!inR(q.date)) return;
                    rows.push({ kind: 'note', date: q.date, time: q.time, sortTime: q.time, minutes: 0, project, title, tabName, content: q.text, source: '閃念', cardId: card.id });
                });
            });
            rows.sort((a, b) => a.date.localeCompare(b.date) || a.sortTime.localeCompare(b.sortTime) || a.project.localeCompare(b.project, 'zh-Hant'));
            const days = new Map();
            rows.forEach(x => { if (!days.has(x.date)) days.set(x.date, []); days.get(x.date).push(x); });
            return { r, rows, days };
        },

        dayLabel(date) {
            const d = app.worktime.parseLocalDate(date);
            return d ? `${d.getMonth() + 1}/${d.getDate()}（${'日一二三四五六'[d.getDay()]}）` : date;
        },
        hours(min) { return Math.round(min / 60 * 100) / 100; },

        // 每天 × 卡片的彙總：大多數公司工時表要的就是這個
        summary(data) {
            const out = [];
            data.days.forEach((list, date) => {
                const byCard = new Map();
                list.forEach(x => {
                    const k = x.cardId;
                    if (!byCard.has(k)) byCard.set(k, { date, project: x.project, title: x.title, minutes: 0, items: [], cardId: k });
                    const g = byCard.get(k);
                    g.minutes += x.minutes;
                    if (x.kind === 'work' && !['心流計時', '手動補登'].includes(x.content) && !g.items.includes(x.content)) g.items.push(x.content);
                    if (x.kind === 'note' && !g.items.includes(x.content)) g.items.push(x.content);
                });
                byCard.forEach(g => {
                    if (!g.items.length) {
                        const card = app.worktime.getCard(g.cardId);
                        const d = String(card?.deliverable || '').trim();
                        g.items.push(d ? `執行：${d}` : '（未填工作內容）');
                    }
                    out.push(g);
                });
            });
            return out;
        },

        text(data = this.collect()) {
            const W = app.worktime;
            if (!data.rows.length) return `【工作日誌】${data.r.s} ～ ${data.r.e}\n（這段期間沒有紀錄）`;
            const lines = [`【工作日誌】${data.r.s} ～ ${data.r.e}`];
            let total = 0;
            data.days.forEach((list, date) => {
                const dayMin = list.reduce((s, x) => s + x.minutes, 0);
                total += dayMin;
                lines.push('', `■ ${this.dayLabel(date)}　共 ${W.formatMinutes(dayMin)}`);
                list.forEach(x => {
                    const t = x.time ? `${x.time} ` : '';
                    const dur = x.minutes ? `（${W.formatMinutes(x.minutes)}）` : '';
                    const mark = x.kind === 'note' ? '📝 ' : '';
                    const cat = x.kind === 'work' && x.category ? `〔${x.category}〕` : '';
                    lines.push(`・${t}${mark}${cat}[${x.project}] ${x.title}：${x.content}${dur}`);
                });
            });
            lines.push('', `合計工時：${W.formatMinutes(total)}`);
            return lines.join('\n');
        },

        set(field, value) {
            if (field === 'range') this.filters.range = value;
            if (field === 'from' || field === 'to') { this.filters[field] = value; this.filters.range = 'custom'; }
            if (field === 'withNotes') this.filters.withNotes = !!value;
            app.report.render();
        },

        renderPanel() {
            const esc = s => app.entries.escapeHtml(s);
            const W = app.worktime;
            const data = this.collect();
            const f = this.filters;
            const totalMin = data.rows.reduce((s, x) => s + x.minutes, 0);
            const opt = (v, l) => `<option value="${v}" ${f.range === v ? 'selected' : ''}>${l}</option>`;
            const days = [...data.days.entries()].map(([date, list]) => `
                <div class="journal-day">
                    <div class="journal-day-head"><b>${esc(this.dayLabel(date))}</b><span>${W.formatMinutes(list.reduce((s, x) => s + x.minutes, 0))}</span></div>
                    ${list.map(x => `<button type="button" class="journal-row ${x.kind}" onclick="app.actions.jumpToCard('${x.cardId}')">
                        <span class="journal-time">${esc(x.time || '—')}</span>
                        <span class="journal-main">${x.kind === 'work' && x.category ? `<span class="journal-cat">${esc(x.category)}</span> ` : ''}<span class="journal-proj">${esc(x.project)}</span> ${esc(x.title)}<br><small>${x.kind === 'note' ? `📝 ${esc(x.source)}：` : ''}${esc(x.content)}</small></span>
                        <span class="journal-dur">${x.minutes ? esc(W.formatMinutes(x.minutes)) : ''}</span>
                    </button>`).join('')}
                </div>`).join('');
            return `
                <section class="journal-panel">
                    <div class="report-text-head">
                        <b>🗒 工作日誌（給公司填工時用）</b>
                        <span style="display:flex;gap:6px;flex-wrap:wrap;">
                            <button class="excel-copy-btn" onclick="app.journal.copyForAI()" title="把這段期間的紀錄、公司類別與格式一起複製，貼給 AI 就會整理成公司工時表">🧑‍🏫 複製給 AI 產生公司工時表</button>
                            <button class="excel-copy-btn" onclick="app.journal.copy()">📋 複製日誌文字</button>
                            <button class="excel-copy-btn" onclick="app.journal.exportXlsx()">⬇️ 匯出 Excel</button>
                        </span>
                    </div>
                    <div class="journal-controls">
                        <select class="gantt-filter-select" onchange="app.journal.set('range',this.value)">
                            ${opt('today', '今天')}${opt('week', '本週')}${opt('lastweek', '上週')}${opt('month', '本月')}${opt('lastmonth', '上個月')}${opt('custom', '自訂日期')}
                        </select>
                        <input type="date" class="gantt-filter-select" value="${esc(f.range === 'custom' ? f.from : data.r.s)}" onchange="app.journal.set('from',this.value)">
                        <span>～</span>
                        <input type="date" class="gantt-filter-select" value="${esc(f.range === 'custom' ? f.to : data.r.e)}" onchange="app.journal.set('to',this.value)">
                        <label class="journal-check"><input type="checkbox" ${f.withNotes ? 'checked' : ''} onchange="app.journal.set('withNotes',this.checked)"> 包含工作紀錄與閃念</label>
                        <span class="report-hours">合計 <b>${W.formatMinutes(totalMin)}</b></span>
                    </div>
                    ${data.rows.length ? `<div class="journal-days">${days}</div>` : '<div class="data-empty" style="padding:12px;">這段期間沒有工時或工作紀錄。用卡片上的 ⏱️ 計時，或在「工時」補登，就會出現在這裡。</div>'}
                    <details class="journal-ai-settings" ${f.showAiSettings ? 'open' : ''} ontoggle="app.journal.filters.showAiSettings=this.open">
                        <summary>給 AI 的專案名稱對照（選填）</summary>
                        <div class="data-note">公司的四個專案（環境部、化學署、氣候變遷署、公司/部門事務）已經內建，AI 會依工作區和專案名稱自動判斷。只有判斷容易錯的，才需要在這裡寫：白板上的專案名稱 = 公司案名。</div>
                        <textarea class="task-meta-textarea" rows="4" placeholder="化學署官網會議 = 化學物質管理署「114-116年度中英文全球資訊網與業務網站整合、維運暨功能擴增案」&#10;環境部 = 環境部「115-116年度內外網系統維運暨功能擴增案」&#10;日常 = 公司/部門事務" oninput="app.journal.saveProjectMap(this.value)">${esc(app.prefs.companyProjectMap || '')}</textarea>
                    </details>
                    <div class="data-note" style="padding:0 12px 10px;">時間欄：計時的紀錄會自動有起訖時間；補登時可以選填「開始」時間。只有日期的補登，時間欄會留白。</div>
                </section>`;
        },

        copy() { app.worktime.copyText(this.text(), '已複製工作日誌'); },

        saveProjectMap(v) { app.prefs.companyProjectMap = v; app.store.savePrefs(); },

        aiPrompt(data = this.collect()) {
            const W = app.worktime;
            const lines = [];
            data.days.forEach((list, date) => {
                lines.push(`## ${this.dayLabel(date).replace(/^\d+\/\d+/, date)}`);
                list.forEach(x => {
                    if (x.kind === 'work') lines.push(`- ${x.time || '（未記時間）'}｜${Math.round(x.minutes)} 分｜工作區：${x.tabName}｜專案：${x.project}｜卡片：${x.title}｜內容：${x.content}${x.category ? `｜我選的類別：${x.category}` : ''}`);
                    else lines.push(`- ${x.time || ''}｜（筆記，不算工時）｜工作區：${x.tabName}｜專案：${x.project}｜卡片：${x.title}｜${x.content}`);
                });
            });
            const map = String(app.prefs.companyProjectMap || '').trim();
            return [
                '請幫我把下面的工作紀錄整理成公司工時表。',
                '',
                '【輸出格式】',
                '用「定位字元（Tab）分隔」的純文字表格，放在一個程式碼區塊裡，方便我直接貼進 Google 試算表。',
                '欄位依序：日期（YYYY-MM-DD）｜工作類別｜工作項目｜專案｜工時（分鐘）。不要有標題列以外的說明文字混在表格裡。',
                '',
                '【規則】',
                '1. 工作類別只能從下面清單選一個，依工作內容判斷：',
                WORK_CATEGORIES.map(c => `   - ${c}`).join('\n'),
                '2. 同一天、同一個專案、同一類別的工作合併成一列，工時加總。',
                '3. 工作項目用 4～12 個字的簡短名稱（像「網站檢核規劃」「雙周會報告製作」），從卡片名稱與內容歸納，不要照抄流水帳。',
                '4. 專案欄只能從下面的公司專案清單選一個（照抄全名）：',
                COMPANY_PROJECTS.map(c => `   - ${c}`).join('\n'),
                '   判斷順序：先看【專案名稱對照】；沒有的話，依「工作區」與專案名稱判斷（例如工作區「環境部」→ 環境部的案子、「化學署」→ 化學物質管理署的案子、「氣候」→ 氣候變遷署的案子）；公司內部會議、部門事務、行政、訓練等歸到「公司/部門事務」。真的判斷不出來的，在表格後面列出來問我。',
                '5. 標成「筆記，不算工時」的只用來幫你理解當天在做什麼，不要算進工時。',
                '6. 如果我有自己選類別，以我選的為主；你覺得明顯不對時，在表格後面另外提醒我。',
                '7. 表格後面用 1～3 行列出：每天工時合計，以及你不確定、需要我確認的地方。',
                '',
                '【專案名稱對照】（我自己補充的，優先使用）',
                map || '（沒有額外對照，依上面規則判斷）',
                '',
                `【工作紀錄】${data.r.s} ～ ${data.r.e}`,
                lines.join('\n') || '（這段期間沒有紀錄）'
            ].join('\n');
        },

        copyForAI() { app.worktime.copyText(this.aiPrompt(), '已複製，貼給 Claude 就會整理成公司工時表'); },

        async exportXlsx() {
            if (!window.ExcelJS) return app.ui.toast('Excel 匯出元件尚未載入，請確認網路後重新整理', 'warn');
            const W = app.worktime;
            const data = this.collect();
            try {
                const wb = new ExcelJS.Workbook();
                wb.creator = '白板 & 心流沙盒';
                const style = (ws, widths) => {
                    W.styleExcelHeader(ws.getRow(1));
                    widths.forEach((w, i) => ws.getColumn(i + 1).width = w);
                    ws.eachRow((row, n) => { if (n > 1) row.alignment = { vertical: 'top', wrapText: true }; });
                    ws.views = [{ state: 'frozen', ySplit: 1 }];
                };
                // 1) 每日彙總（一天一張卡一列）
                // 0) 公司工時表格式：日期｜工作類別｜工作項目｜專案｜分鐘（同一天、同卡、同類別合併）
                const s0 = wb.addWorksheet('公司工時格式');
                s0.addRow(['日期', '工作類別', '工作項目', '專案', '工時(分鐘)']);
                const groups = new Map();
                data.rows.filter(x => x.kind === 'work').forEach(x => {
                    const k = `${x.date}|${x.cardId}|${x.category}`;
                    if (!groups.has(k)) groups.set(k, { date: x.date, category: x.category || '（未選類別）', title: x.title, project: x.project, minutes: 0 });
                    groups.get(k).minutes += x.minutes;
                });
                [...groups.values()].forEach(g => s0.addRow([g.date, g.category, g.title, g.project, Math.round(g.minutes)]));
                style(s0, [12, 26, 30, 40, 11]);
                s0.autoFilter = { from: 'A1', to: 'E1' };
                const s1 = wb.addWorksheet('每日彙總');
                s1.addRow(['日期', '星期', '專案', '工作項目', '工作內容', '工時(小時)']);
                this.summary(data).forEach(g => {
                    const d = W.parseLocalDate(g.date);
                    s1.addRow([g.date, d ? '日一二三四五六'[d.getDay()] : '', g.project, g.title, g.items.join('；'), this.hours(g.minutes)]);
                });
                const n1 = s1.rowCount;
                s1.addRow(['', '', '', '', '合計', { formula: `SUM(F2:F${Math.max(2, n1)})` }]).font = { bold: true };
                style(s1, [12, 6, 16, 26, 48, 11]);
                s1.autoFilter = { from: 'A1', to: 'F1' };
                // 2) 明細（每一筆）
                const s2 = wb.addWorksheet('明細');
                s2.addRow(['日期', '時間', '工時(分鐘)', '工時(小時)', '工作類別', '專案', '工作項目', '內容', '來源', '工作區']);
                data.rows.forEach(x => s2.addRow([x.date, x.time, Math.round(x.minutes), x.minutes ? this.hours(x.minutes) : '', x.kind === 'work' ? (x.category || '') : '', x.project, x.title, x.content, x.source, x.tabName]));
                style(s2, [12, 13, 11, 11, 24, 16, 26, 48, 10, 12]);
                s2.autoFilter = { from: 'A1', to: 'J1' };
                // 3) 每日合計
                const s3 = wb.addWorksheet('每日合計');
                s3.addRow(['日期', '星期', '工時(小時)']);
                data.days.forEach((list, date) => {
                    const d = W.parseLocalDate(date);
                    s3.addRow([date, d ? '日一二三四五六'[d.getDay()] : '', this.hours(list.reduce((s, x) => s + x.minutes, 0))]);
                });
                style(s3, [12, 6, 11]);

                const buf = await wb.xlsx.writeBuffer();
                const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `工作日誌_${data.r.s.replace(/-/g, '')}-${data.r.e.replace(/-/g, '')}.xlsx`;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (err) {
                console.error(err);
                app.ui.toast('Excel 匯出失敗：' + (err?.message || err), 'warn', 6000);
            }
        }
    },

    // ==========================================
    // 🧑‍🏫 AI 老師：產生「請 AI 先示範、再解釋、最後考我」的提問，並把 AI 的拆解貼回來變成卡片
    // ==========================================
    coach: {
        state: { template: 'wbs', project: '', cardId: '' },

        TEMPLATES: {
            wbs: { icon: '🧱', name: '示範拆解（WBS）', when: '剛接到工作、或專案方向剛確定時。先讓老師拆一版給你看。', needsBrief: true, importable: true },
            review: { icon: '🔍', name: '幫我檢查拆解', when: '已經有一版卡片，想知道哪裡拆得不好、漏了什麼。', needsBrief: true, importable: true },
            fill: { icon: '✍️', name: '幫我填這張卡', when: '交付與進度不知道怎麼填時。AI 依卡片內容先填一版，貼回來就會自動帶入，你再修改。', needsCard: true },
            stuck: { icon: '🧭', name: '我卡住了', when: '某張卡做不下去，不知道是缺資訊、缺決策還是拆太大。', needsCard: true },
            ask: { icon: '💬', name: '幫我問同事', when: '要找人問問題或請人幫忙，想把問題縮到對方好回答。', needsCard: true },
            status: { icon: '📣', name: '進度報告', when: '要跟主管或合作者回報進度。會帶入週報內容。' },
            retro: { icon: '🔁', name: '每週復盤', when: '每週一次，看計畫和實際差在哪，決定下週調整一件事。' }
        },

        TEACHER: [
            '你是一位資深專案經理，也是我的老師。我正在學專案管理，特別是「以交付物為主的拆解」和「跟別人協作、回報進度」。',
            '請用「先示範、再解釋、最後考我」的方式帶我：',
            '1. 先直接示範你會怎麼做。資訊不足時，先寫下你的假設再往下做，不要一開始就丟一串問題給我。',
            '2. 再用簡短條列說明你為什麼這樣做：判斷依據、常見陷阱、新手最容易漏掉的地方。',
            '3. 最後問我 1～2 個問題：確認我懂了，或請我補上最關鍵的缺漏資訊。',
            '請具體、直接，用我的實際情況舉例，不要只講原則。'
        ].join('\n'),

        IMPORT_FORMAT: [
            '最後請用下面的格式輸出「可匯入清單」，放在一個程式碼區塊裡（每個工作包一行；底下用「  - [ ] 」列出我個人的執行步驟，可省略）：',
            '```',
            '- 工作包名稱 | 開始 YYYY-MM-DD | 完成 YYYY-MM-DD | 完成標準 | 預估小時',
            '  - [ ] 步驟',
            '```'
        ].join('\n'),

        projects() {
            return [...new Set(app.worktime.allCards().filter(r => !app.sync.isBlankCard(r.card)).map(r => String(r.card.project || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
        },

        // 專案簡述：先看這台裝置存過的；沒有的話試著從 Project Lab 讀（同一個網域）。
        brief(project) {
            const saved = app.prefs.briefs?.[project];
            if (saved) return { ...saved };
            const b = { goal: '', deliverable: '', deadline: '', stakeholders: '', constraints: '' };
            try {
                const lab = JSON.parse(localStorage.getItem(`project_lab_state_${app.currentUser.uid}`) || 'null');
                const p = lab && Object.values(lab.projects || {}).find(x => (x.sourceName || x.name) === project);
                if (p) {
                    b.goal = p.purpose || '';
                    b.deliverable = p.goal || p.definitionOfDone || '';
                    b.deadline = p.deadline || '';
                }
            } catch {}
            return b;
        },

        saveBrief() {
            const project = this.state.project;
            if (!project) return;
            const val = id => document.getElementById(id)?.value || '';
            if (!app.prefs.briefs) app.prefs.briefs = {};
            app.prefs.briefs[project] = { goal: val('coach-goal'), deliverable: val('coach-deliverable'), deadline: val('coach-deadline'), stakeholders: val('coach-stakeholders'), constraints: val('coach-constraints') };
            app.store.savePrefs();
            this.updatePrompt();
        },

        cardLine(card) {
            const W = app.worktime;
            const s = W.plannedStart(card), e = W.plannedEnd(card);
            const bits = [
                `- ${card.title || '未命名'}`,
                `狀態：${W.statusLabel(card.status)}${card.progress !== undefined && card.progress !== '' ? ` ${W.progressValue(card)}%` : ''}`,
                card.isMemo ? '自由卡' : `日期：${s || '未排'}${e && e !== s ? `～${e}` : ''}`,
                card.deliverable ? `交付：${card.deliverable}` : '',
                card.acceptance ? `完成標準：${card.acceptance}` : '',
                W.totalMinutes(card) ? `已投入 ${W.formatMinutes(W.totalMinutes(card))}${W.plannedMinutes(card) ? ` / 預估 ${W.formatMinutes(W.plannedMinutes(card))}` : ''}` : '',
                card.nextStep ? `下一步：${card.nextStep}` : '',
                card.waitingWho || card.waitingWhat ? `在等：${card.waitingWho || ''} ${card.waitingWhat || ''}`.trim() : ''
            ].filter(Boolean);
            return bits.join('｜');
        },

        projectCards(project) {
            return app.worktime.allCards().filter(r => !app.sync.isBlankCard(r.card) && String(r.card.project || '').trim() === project).map(r => r.card);
        },

        briefText(project, b) {
            return [
                `專案／工作：${project || '（未指定）'}`,
                `目的（為什麼要做、誰需要）：${b.goal || '（未填）'}`,
                `最後要交出什麼：${b.deliverable || '（未填）'}`,
                `期限：${b.deadline || '（未填）'}`,
                `合作對象／誰會看結果：${b.stakeholders || '（未填）'}`,
                `已知限制、資源：${b.constraints || '（未填）'}`
            ].join('\n');
        },

        buildPrompt() {
            const { template, project, cardId } = this.state;
            const today = app.worktime.localDateString();
            const b = this.readBriefFields();
            const cards = project ? this.projectCards(project) : [];
            const cardsText = cards.length ? cards.map(c => this.cardLine(c)).join('\n') : '（目前還沒有卡片）';
            const card = cardId ? app.worktime.getCard(cardId) : null;
            const head = `${this.TEACHER}\n\n今天是 ${today}。`;

            if (template === 'wbs') return `${head}

【我的情況】
${this.briefText(project, b)}
目前已經有的卡片（可能不完整，也可能拆得不好）：
${cardsText}

【請你示範】
1. 以「交付物」為主拆出 WBS，不要拆成操作步驟。每個工作包大約 1～10 個工作天能完成、能估、能回報進度。近兩週的拆細一點，後面的先保持粗略（滾動式規劃）。
2. 標出里程碑、工作包之間的依賴，以及我需要等別人或請別人幫忙的地方。
3. 指出最大的 2～3 個風險，或需要最先跟誰確認的事。
4. 如果「目的」和「要交出什麼」看起來對不上，請直接指出來，並建議我該先跟誰確認。

${this.IMPORT_FORMAT}`;

            if (template === 'review') return `${head}

【我的情況】
${this.briefText(project, b)}

【我目前的拆解與排程】
${cardsText}

【請你像主管或資深 PM 審查計畫一樣挑毛病】
1. 哪些項目其實是「步驟」而不是「交付物」？哪些太大、哪些太細？
2. 有沒有漏掉的工作包（例如需求確認、審查與修改、交付後的事、等別人的時間）？
3. 時程與依賴合不合理？哪裡最可能延誤？
4. 給我修改後的版本，並說明你改了什麼、為什麼。

${this.IMPORT_FORMAT}`;

            if (template === 'fill') {
                if (!card) return '請先在上方選一張卡片。';
                const notes = String(card.content || '').slice(0, 1500);
                const entries = (card.entries || []).slice(-5).map(e => `- ${e.title}${e.content ? `：${String(e.content).slice(0, 200)}` : ''}`).join('\n');
                const logs = app.worktime.getLogs(card).slice(-5).map(l => `- ${l.workDate} ${app.worktime.formatMinutes(app.worktime.logMinutes(l))}：${l.note || ''}`).join('\n');
                return `${head}

【這張卡】
工作區：${app.state.tabs.find(t => (app.state.workspaces[t.id] || []).some(c => c.id === card.id))?.name || ''}
專案：${String(card.project || '').trim() || '未分類'}
${this.cardLine(card)}
卡片筆記：
${notes || '（無）'}
${entries ? `最近的工作紀錄：\n${entries}\n` : ''}${logs ? `最近的工時：\n${logs}\n` : ''}${project ? `\n【專案背景】\n${this.briefText(project, b)}\n` : ''}
【請你示範怎麼把這張卡寫成一個清楚的工作包】
1. 先判斷：這張卡是一個「交付物」（做完別人拿得到東西），還是其實是一個步驟、或只是一個想法？如果太大，建議怎麼拆（簡短說明即可）。
2. 幫我填好下面的欄位。資訊不足時，依常理先寫合理的假設，並在「待確認」說明。日期用 YYYY-MM-DD；不需要的欄位留空。
3. 簡短說明你這樣寫的理由，以及我最該先跟誰確認什麼。

最後請用下面的格式輸出「可貼回清單」，放在一個程式碼區塊裡（每行一個欄位，冒號後面填內容）：
\`\`\`
要交出什麼：
怎樣算完成：
預計開始：
預計完成：
下一步：
在等誰：
在等什麼：
預估小時：
\`\`\``;
            }

            if (template === 'stuck' || template === 'ask') {
                if (!card) return '請先在上方選一張卡片。';
                const W = app.worktime;
                const notes = String(card.content || '').slice(0, 1500);
                const entries = (card.entries || []).slice(-5).map(e => `- ${e.title}${e.content ? `：${String(e.content).slice(0, 200)}` : ''}`).join('\n');
                const ctx = `【這張卡】
專案：${String(card.project || '').trim() || '未分類'}
${this.cardLine(card)}
卡片筆記：
${notes || '（無）'}
${entries ? `最近的工作紀錄：\n${entries}` : ''}
${project ? `\n【專案背景】\n${this.briefText(project, b)}` : ''}`;
                if (template === 'stuck') return `${head}

${ctx}

【我卡住了，請帶我判斷】
1. 先判斷我卡住的類型：缺資訊、缺決策、缺人或資源、工作拆得太大、技術上未知，或其實是目的不清楚。說明你的依據。
2. 示範接下來 1～3 個具體動作，最好是今天就能做的。
3. 如果需要問人或請人決定，告訴我該問誰，並幫我寫一則可以直接傳給對方的簡短訊息。
4. 如果這張卡應該再拆，示範怎麼拆（用可匯入格式）。

${this.IMPORT_FORMAT}`;
                return `${head}

${ctx}
我想詢問／請求的對象：${card.waitingWho || '（請幫我判斷該問誰）'}
我想知道或需要對方做的事：${card.waitingWhat || '（請依卡片內容判斷）'}

【請幫我把問題縮到對方好回答】
1. 對方不是這個專案的負責人，請只放他回答這一題需要的最少背景。
2. 示範一則訊息：一句背景、一個明確的問題（最好能用選項回答）、希望何時回覆、為什麼需要。
3. 再給一個更短、適合即時通訊的版本。
4. 說明這樣寫的原因，以及新手問問題最常犯的錯。`;
            }

            if (template === 'status') {
                const r = app.report.text();
                return `${head}

以下是我這週從工作白板自動整理出來的週報（可能有點雜）：
${r}

${project ? `【專案背景】\n${this.briefText(project, b)}\n` : ''}
【請示範一份好的進度報告】
1. 改寫成給主管／合作者看的版本：先講結論（整體是否照計畫），再講完成了什麼、下週做什麼、風險與需要誰協助（具體到人和日期）。
2. 控制在 10 行內，避免流水帳。
3. 說明好的進度報告和流水帳差在哪，以及我這份原稿最需要改進的一點。`;
            }

            if (template === 'retro') {
                const data = app.report.collect();
                const W = app.worktime;
                const planned = app.report.rows().filter(({ card }) => !card.isMemo && Number(card.status) !== 2 && W.plannedEnd(card) && W.plannedEnd(card) <= data.wk.e && W.plannedEnd(card) >= data.wk.s);
                return `${head}

【這週的實際狀況】
${app.report.text(data)}

【原本預計這週完成、但還沒完成的】
${planned.length ? planned.map(({ card }) => this.cardLine(card)).join('\n') : '（無）'}

【請當我的教練帶我做每週復盤】
1. 用 3～5 句話點出這週「計畫 vs 實際」最重要的落差，並猜測可能原因（估太少、被插件、等別人、拆太大、目的不清楚⋯）。
2. 指出一件我做得不錯、值得保留的事。
3. 建議下週只調整「一件事」，要具體到我能照做。
4. 最後問我 1 個問題，幫我確認你的猜測對不對。`;
            }
            return '';
        },

        readBriefFields() {
            const val = id => document.getElementById(id)?.value || '';
            if (!document.getElementById('coach-goal')) return this.brief(this.state.project);
            return { goal: val('coach-goal'), deliverable: val('coach-deliverable'), deadline: val('coach-deadline'), stakeholders: val('coach-stakeholders'), constraints: val('coach-constraints') };
        },

        open(opts = {}) {
            app.store.flush();
            const st = this.state;
            if (opts.template && this.TEMPLATES[opts.template]) st.template = opts.template;
            if (opts.cardId) {
                st.cardId = opts.cardId;
                const c = app.worktime.getCard(opts.cardId);
                if (c) st.project = String(c.project || '').trim();
            }
            if (opts.project !== undefined) st.project = opts.project;
            if (!st.project) st.project = this.projects()[0] || '';
            document.getElementById('modal-coach').style.display = 'flex';
            this.render();
        },
        close() { document.getElementById('modal-coach').style.display = 'none'; },

        setTemplate(t) { this.state.template = t; this.render(); },
        setProject(p) { this.state.project = p; this.state.cardId = ''; this.render(); },
        setCard(id) { this.state.cardId = id; this.updatePrompt(); },

        render() {
            const esc = s => app.entries.escapeHtml(s);
            const st = this.state;
            const T = this.TEMPLATES[st.template];
            const projects = this.projects();
            const b = this.brief(st.project);
            const cards = st.project ? this.projectCards(st.project) : app.worktime.allCards().filter(r => !app.sync.isBlankCard(r.card)).map(r => r.card);
            if (T.needsCard && !st.cardId && cards.length) st.cardId = cards[0].id;
            const tabs = Object.entries(this.TEMPLATES).map(([k, t]) => `<button type="button" class="coach-tab ${k === st.template ? 'active' : ''}" onclick="app.coach.setTemplate('${k}')">${t.icon} ${esc(t.name)}</button>`).join('');
            const field = (id, label, value, ph, rows = 1) => `<label class="task-meta-field"><span class="task-meta-label">${label}</span>${rows > 1
                ? `<textarea id="${id}" class="task-meta-textarea" rows="${rows}" placeholder="${esc(ph)}" oninput="app.coach.saveBrief()">${esc(value)}</textarea>`
                : `<input id="${id}" class="task-meta-input" value="${esc(value)}" placeholder="${esc(ph)}" oninput="app.coach.saveBrief()">`}</label>`;
            document.getElementById('coach-render-target').innerHTML = `
                <div class="coach-tabs">${tabs}</div>
                <div class="coach-when">💡 ${esc(T.when)}</div>
                <div class="task-meta-grid" style="grid-template-columns:1fr 1fr;">
                    <label class="task-meta-field"><span class="task-meta-label">專案</span>
                        <select class="task-meta-input" onchange="app.coach.setProject(this.value)">
                            <option value="">（不指定）</option>
                            ${projects.map(p => `<option value="${esc(p)}" ${p === st.project ? 'selected' : ''}>${esc(p)}</option>`).join('')}
                        </select>
                    </label>
                    ${T.needsCard ? `<label class="task-meta-field"><span class="task-meta-label">卡片</span>
                        <select class="task-meta-input" onchange="app.coach.setCard(this.value)">
                            ${cards.map(c => `<option value="${c.id}" ${c.id === st.cardId ? 'selected' : ''}>${esc(c.title || '未命名')}</option>`).join('')}
                        </select></label>` : '<span></span>'}
                </div>
                <details class="coach-brief" ${T.needsBrief ? 'open' : ''}>
                    <summary>專案簡述（會帶進提問；${st.project ? '自動記在這台裝置' : '先選專案才會記住'}）</summary>
                    <div class="task-meta-grid" style="grid-template-columns:1fr 1fr;margin-top:6px;">
                        ${field('coach-goal', '目的：為什麼要做、誰需要', b.goal, '例如：讓月報從 2 天縮到半天，主管每月 5 號要看', 2)}
                        ${field('coach-deliverable', '最後要交出什麼', b.deliverable, '例如：可重複使用的月報產生流程＋使用說明', 2)}
                        ${field('coach-deadline', '期限', b.deadline, '例如：2026-11-30（11/15 先給主管看初版）')}
                        ${field('coach-stakeholders', '合作對象／誰會看結果', b.stakeholders, '例如：主管（驗收）、資訊組小陳（資料來源）')}
                    </div>
                    ${field('coach-constraints', '已知限制、資源', b.constraints, '例如：每週大約只有 10 小時能做；不能改資料庫', 1)}
                </details>
                <label class="task-meta-field" style="margin-top:10px;"><span class="task-meta-label">要貼給 AI 的提問（可以再自己修改）</span>
                    <textarea id="coach-prompt" class="coach-prompt" rows="12"></textarea>
                </label>
                <div class="data-actions">
                    <button class="excel-copy-btn" onclick="app.coach.copy()">📋 複製提問</button>
                    <a class="excel-copy-btn" href="https://claude.ai/new" target="_blank" rel="noopener" onclick="app.coach.copy(true)">↗ 複製並打開 Claude</a>
                </div>
                ${st.template === 'fill' ? `
                <div class="coach-import">
                    <div class="task-meta-label">📥 把 AI 回覆裡的「可貼回清單」貼到這裡，會自動填進這張卡（之後可以再改）</div>
                    <textarea id="coach-fill-text" class="task-meta-textarea" rows="7" placeholder="要交出什麼：網站檢核報告（含問題清單）&#10;怎樣算完成：主管看過並確認修正優先順序&#10;預計開始：2026-11-02&#10;預計完成：2026-11-06&#10;下一步：列出要檢核的頁面範圍&#10;在等誰：&#10;在等什麼：&#10;預估小時：6"></textarea>
                    <div class="data-actions"><button class="excel-copy-btn" onclick="app.coach.applyFill()">✅ 填進這張卡</button></div>
                </div>` : ''}
                ${T.importable || st.template === 'stuck' ? `
                <div class="coach-import">
                    <div class="task-meta-label">📥 把 AI 回覆裡的「可匯入清單」貼回來，變成卡片</div>
                    <textarea id="coach-import-text" class="task-meta-textarea" rows="5" placeholder="- 需求確認 | 開始 2026-11-02 | 完成 2026-11-04 | 主管確認範圍 | 4&#10;  - [ ] 整理目前月報流程"></textarea>
                    <div class="data-actions"><button class="excel-copy-btn" onclick="app.coach.previewImport()">解析預覽</button></div>
                    <div id="coach-import-preview"></div>
                </div>` : ''}`;
            this.updatePrompt();
        },

        updatePrompt() {
            const el = document.getElementById('coach-prompt');
            if (el) el.value = this.buildPrompt();
        },

        copy(silent = false) {
            const text = document.getElementById('coach-prompt')?.value || this.buildPrompt();
            app.worktime.copyText(text, silent ? '已複製提問，到 Claude 貼上即可' : '已複製提問，貼到 Claude 或其他 AI 即可');
        },

        parseFill(text) {
            const map = { '要交出什麼': 'deliverable', '交付': 'deliverable', '怎樣算完成': 'acceptance', '完成標準': 'acceptance', '預計開始': 'start', '開始': 'start', '預計完成': 'end', '完成': 'end', '下一步': 'nextStep', '在等誰': 'waitingWho', '在等什麼': 'waitingWhat', '預估小時': 'hours', '預估工時': 'hours' };
            const out = {};
            String(text || '').replace(/```[a-z]*\n?/gi, '').split(/\r?\n/).forEach(line => {
                const m = line.match(/^\s*[-*]?\s*\**([^:：*]+?)\**\s*[:：]\s*(.*)$/);
                if (!m) return;
                const key = map[m[1].trim()];
                if (!key) return;
                let v = m[2].trim().replace(/^[（(]?(無|空白|不需要|N\/A|—|-)[）)]?$/i, '');
                if (key === 'start' || key === 'end') v = (v.match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
                if (key === 'hours') { const n = v.match(/\d+(?:\.\d+)?/); v = n ? Number(n[0]) : ''; }
                out[key] = v;
            });
            return out;
        },

        applyFill() {
            const card = app.worktime.getCard(this.state.cardId);
            if (!card) { app.ui.toast('找不到這張卡片', 'warn'); return; }
            const f = this.parseFill(document.getElementById('coach-fill-text')?.value);
            const keys = Object.keys(f);
            if (!keys.length) { app.ui.toast('沒有讀到欄位。每行要像「要交出什麼：…」這樣。', 'warn'); return; }
            const W = app.worktime;
            ['deliverable', 'acceptance', 'nextStep', 'waitingWho', 'waitingWhat'].forEach(k => {
                if (f[k] === undefined) return;
                if (f[k]) card[k] = f[k]; else if (k.startsWith('waiting')) delete card[k];
                if (k === 'nextStep') card.nextAction = card.nextStep;
            });
            if (f.start || f.end) {
                card.isMemo = false;
                card.dateMode = 'range';
                card.dateStart = f.start || f.end;
                card.dateEnd = f.end && f.end >= card.dateStart ? f.end : card.dateStart;
            }
            if (f.hours) card.plannedMinutes = Math.round(Number(f.hours) * 60);
            app.saveToLocal();
            app.setPanelOpen('timeline', card.id, 'plan', true);
            W.planningUi = {};
            this.close();
            const tab = app.actions.tabOfCard(card.id);
            app.actions.jumpToCard(card.id, tab);
            app.ui.toast(`已填入 ${keys.length} 個欄位，看一下哪裡要改`);
        },

        // 解析「- 名稱 | 開始 日期 | 完成 日期 | 完成標準 | 預估小時」與底下的「  - [ ] 步驟」
        parseImport(text) {
            const items = [];
            String(text || '').replace(/```[a-z]*\n?/gi, '').split(/\r?\n/).forEach(raw => {
                if (!raw.trim()) return;
                const step = raw.match(/^\s+[-*]\s+\[( |x|X)\]\s+(.*)$/) || raw.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
                if (step && items.length) { items[items.length - 1].steps.push(`- [${step[1].toLowerCase() === 'x' ? 'x' : ' '}] ${step[2].trim()}`); return; }
                const m = raw.match(/^\s*(?:[-*]|\d+[.)、])\s+(.*)$/);
                if (!m) return;
                const parts = m[1].split('|').map(x => x.trim());
                const dates = parts.slice(1).map(x => (x.match(/\d{4}-\d{2}-\d{2}/) || [])[0]).filter(Boolean);
                const rest = parts.slice(1).filter(x => !/\d{4}-\d{2}-\d{2}/.test(x));
                const hours = rest.map(x => x.match(/^(\d+(?:\.\d+)?)\s*(?:小時|h|hr|hrs)?$/i)).find(Boolean);
                const acceptance = rest.find(x => !/^(\d+(?:\.\d+)?)\s*(?:小時|h|hr|hrs)?$/i.test(x)) || '';
                const title = parts[0].replace(/\*\*/g, '').trim();
                if (!title) return;
                items.push({ title, start: dates[0] || '', end: dates[1] || dates[0] || '', acceptance, hours: hours ? Number(hours[1]) : 0, steps: [] });
            });
            return items;
        },

        previewImport() {
            const items = this.parseImport(document.getElementById('coach-import-text')?.value);
            this._importItems = items;
            const esc = s => app.entries.escapeHtml(s);
            const project = this.state.project;
            const existing = new Set((project ? this.projectCards(project) : []).map(c => String(c.title || '').trim()));
            const target = document.getElementById('coach-import-preview');
            if (!items.length) { target.innerHTML = '<div class="data-empty">沒有找到符合格式的項目。每個工作包要用「- 」開頭，欄位之間用「|」分隔。</div>'; return; }
            target.innerHTML = `
                <div class="data-note">會建立在目前工作區「${esc(app.state.tabs.find(t => t.id === app.state.activeTabId)?.name || '')}」，專案：<b>${esc(project || '（未指定）')}</b>。已存在同名卡片的預設不勾。</div>
                ${items.map((it, i) => `<label class="coach-import-row"><input type="checkbox" data-idx="${i}" ${existing.has(it.title) ? '' : 'checked'}>
                    <span><b>${esc(it.title)}</b>${existing.has(it.title) ? ' <span class="pm-hint">（已有同名卡片）</span>' : ''}<br><small>${esc([it.start && `${it.start}${it.end && it.end !== it.start ? '～' + it.end : ''}`, it.acceptance && `完成標準：${it.acceptance}`, it.hours && `預估 ${it.hours} 小時`, it.steps.length && `${it.steps.length} 個步驟`].filter(Boolean).join('　'))}</small></span></label>`).join('')}
                <div class="data-actions"><button class="excel-copy-btn" onclick="app.coach.doImport()">✅ 建立勾選的卡片</button></div>`;
        },

        doImport() {
            const items = this._importItems || [];
            const picked = [...document.querySelectorAll('#coach-import-preview input[type=checkbox]:checked')].map(el => items[Number(el.dataset.idx)]).filter(Boolean);
            if (!picked.length) { app.ui.toast('沒有勾選任何項目', 'warn'); return; }
            const project = this.state.project;
            const list = app.state.workspaces[app.state.activeTabId];
            picked.forEach(it => {
                const scheduled = !!it.start;
                const card = {
                    id: app.makeId('card'), title: it.title, content: it.steps.join('\n'), project,
                    deliverable: it.title, acceptance: it.acceptance, workLogs: [],
                    dateMode: scheduled ? 'range' : 'single', dateSingle: '', dateStart: it.start, dateEnd: it.end || it.start,
                    color: 'blue', status: 0, isMemo: !scheduled
                };
                if (it.hours > 0) card.plannedMinutes = Math.round(it.hours * 60);
                list.push(card);
            });
            app.saveToLocal();
            this.close();
            app.state.filters.activeProject = null;
            if (app.state.view !== 'timeline') app.switchView('timeline'); else app.renderAll();
            app.ui.toast(`已建立 ${picked.length} 張卡片（專案：${project || '未分類'}）`);
        }
    },

    // ==========================================
    // 🗂 工作區管理：新增、改名、排序、刪除（刪除時可以把卡片移到別的工作區）
    // ==========================================
    tabsManager: {
        focusId: null,

        open(focusId = null, focusNew = false) {
            this.focusId = focusId;
            document.getElementById('modal-tabs').style.display = 'flex';
            this.render();
            setTimeout(() => {
                const el = focusNew ? document.getElementById('tabs-new-name') : document.querySelector(`[data-tab-name="${CSS.escape(focusId || '')}"]`);
                el?.focus(); if (el && !focusNew) el.select?.();
            }, 50);
        },
        close() { document.getElementById('modal-tabs').style.display = 'none'; app.renderAll(); },

        counts(id) {
            const cards = app.state.workspaces[id] || [];
            const nodes = app.state.nodes[id] || [];
            const mins = cards.reduce((sum, c) => sum + app.worktime.totalMinutes(c), 0);
            return { cards: cards.length, nodes: nodes.length, mins };
        },

        render() {
            const esc = s => app.entries.escapeHtml(s);
            const tabs = app.state.tabs;
            const rows = tabs.map((t, i) => {
                const c = this.counts(t.id);
                return `<div class="tabs-row ${t.id === this.focusId ? 'focus' : ''}">
                    <span class="tabs-order">
                        <button type="button" class="worklog-action-btn" ${i === 0 ? 'disabled' : ''} title="往上" onclick="app.tabsManager.move('${t.id}',-1)">▲</button>
                        <button type="button" class="worklog-action-btn" ${i === tabs.length - 1 ? 'disabled' : ''} title="往下" onclick="app.tabsManager.move('${t.id}',1)">▼</button>
                    </span>
                    <input class="task-meta-input" data-tab-name="${esc(t.id)}" value="${esc(t.name)}" oninput="app.tabsManager.rename('${t.id}', this.value)" onblur="app.tabsManager.commitName('${t.id}', this)">
                    <span class="tabs-meta">${c.cards} 張卡${c.nodes ? `・${c.nodes} 個節點` : ''}${c.mins ? `・${app.worktime.formatMinutes(c.mins)}` : ''}</span>
                    <span class="tabs-actions">
                        <button type="button" class="worklog-action-btn" onclick="app.tabsManager.go('${t.id}')">開啟</button>
                        ${tabs.length > 1 ? `<button type="button" class="worklog-action-btn danger" onclick="app.tabsManager.remove('${t.id}')">刪除…</button>` : ''}
                    </span>
                </div>`;
            }).join('');
            document.getElementById('tabs-render-target').innerHTML = `
                <div class="data-note" style="margin-bottom:8px;">工作區可以照你習慣的方式分：依案子、依角色、或乾脆只用一個。名稱直接改、▲▼ 調整順序。刪除時可以把卡片搬到別的工作區，不用一起刪。</div>
                <div class="tabs-list">${rows}</div>
                <div class="tabs-new">
                    <input id="tabs-new-name" class="task-meta-input" placeholder="新工作區名稱，例如：氣候變遷署" onkeydown="if(event.key==='Enter') app.tabsManager.add()">
                    <button type="button" class="excel-copy-btn" onclick="app.tabsManager.add()">＋ 新增工作區</button>
                </div>
                <div class="data-note" style="margin-top:8px;">💡 工作區名稱會一起交給 AI 產生公司工時表，名稱裡有「環境部」「化學署」「氣候」等字，AI 比較容易對應到公司案名。</div>`;
        },

        rename(id, value) {
            const t = app.state.tabs.find(x => x.id === id);
            if (!t || !value.trim()) return;
            t.name = value.trim();
            app.saveToLocal();
            app.renderTabs();
        },
        commitName(id, el) {
            const t = app.state.tabs.find(x => x.id === id);
            if (t && !el.value.trim()) el.value = t.name;
        },

        move(id, dir) {
            const tabs = app.state.tabs;
            const i = tabs.findIndex(t => t.id === id);
            const j = i + dir;
            if (i < 0 || j < 0 || j >= tabs.length) return;
            [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
            app.saveToLocal();
            app.renderTabs();
            this.render();
        },

        add() {
            const input = document.getElementById('tabs-new-name');
            const name = (input?.value || '').trim();
            if (!name) { input?.focus(); return; }
            const id = app.makeId('tab');
            app.state.tabs.push({ id, name });
            app.state.workspaces[id] = [];
            app.state.nodes[id] = [];
            app.saveToLocal();
            app.renderTabs();
            this.focusId = id;
            this.render();
            document.getElementById('tabs-new-name')?.focus();
            app.ui.toast(`已新增工作區「${name}」`);
        },

        go(id) {
            this.close();
            app.actions.switchTab(id);
        },

        async remove(id) {
            const esc = s => app.entries.escapeHtml(s);
            const tabs = app.state.tabs;
            const tab = tabs.find(t => t.id === id);
            if (!tab || tabs.length <= 1) return;
            const c = this.counts(id);
            const others = tabs.filter(t => t.id !== id);
            let choice = 'empty';
            this._moveTarget = others[0].id;
            if (c.cards || c.nodes) {
                choice = await app.ui.dialog({
                    title: `刪除工作區「${tab.name}」`,
                    html: `<p>裡面有 <b>${c.cards}</b> 張卡片${c.nodes ? `、${c.nodes} 個發想節點` : ''}${c.mins ? `（${app.worktime.formatMinutes(c.mins)} 工時）` : ''}。</p>
                        <label class="task-meta-field"><span class="task-meta-label">卡片要搬去哪裡？</span>
                        <select id="tabs-move-target" class="task-meta-input" onchange="app.tabsManager._moveTarget=this.value">${others.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>
                        <p class="data-note">選「一起刪除」的話，卡片會先放進「🗂 資料 → 最近刪除」。</p>`,
                    buttons: [{ label: '取消', value: null }, { label: '連卡片一起刪除', value: 'delete', danger: true }, { label: '搬過去，再刪除工作區', value: 'move', primary: true }]
                });
                if (!choice) return;
            } else if (!await app.ui.confirm('刪除工作區', `<p>刪除空的工作區「${esc(tab.name)}」？</p>`, '刪除', true)) return;
            const target = choice === 'move' ? (others.some(t => t.id === this._moveTarget) ? this._moveTarget : others[0].id) : null;
            const cards = app.state.workspaces[id] || [];
            const nodes = app.state.nodes[id] || [];
            if (choice === 'delete') {
                const sb = app.state.sandbox;
                if (sb.timerStatus !== 'IDLE' && cards.some(x => x.id === sb.timerTaskId)) app.sandbox.stopTimer();
                if (!await app.backup.trashOrConfirm(cards.map(card => ({ card, tabId: id })), `刪除工作區「${tab.name}」`)) return;
            }
            await app.backup.save(`刪除工作區「${tab.name}」前`, app.store.serialize());
            if (choice === 'move' && target) {
                app.state.workspaces[target] = [...(app.state.workspaces[target] || []), ...cards];
                app.state.nodes[target] = [...(app.state.nodes[target] || []), ...nodes];
            }
            app.state.tabs = tabs.filter(t => t.id !== id);
            delete app.state.workspaces[id];
            delete app.state.nodes[id];
            if (app.state.activeTabId === id) app.state.activeTabId = target || app.state.tabs[0].id;
            app.saveToLocal();
            app.rememberPrefs();
            app.renderTabs();
            this.focusId = null;
            this.render();
            const tn = target ? app.state.tabs.find(t => t.id === target)?.name : '';
            app.ui.toast(choice === 'move' ? `已刪除「${tab.name}」，${cards.length} 張卡片搬到「${tn}」` : `已刪除「${tab.name}」`);
        }
    },

    actions: {
        addCard(mode = 'free') {
            const today = app.worktime.localDateString();
            const scheduled = mode === 'scheduled';
            const newCard = {
                id: app.makeId('card'), title: '', content: '', project: app.state.filters.activeProject || '',
                category: '', progress: '', deliverable: '', acceptance: '', workLogs: [],
                dateMode: scheduled ? 'range' : 'single', dateSingle: '',
                dateStart: scheduled ? today : '', dateEnd: scheduled ? today : '',
                color: 'blue', status: 0, isMemo: !scheduled
            };
            app.state.workspaces[app.state.activeTabId].push(newCard);
            app.saveToLocal();
            if (app.state.view !== 'timeline') app.switchView('timeline'); else app.renderAll();
            // 新卡片直接捲到眼前、游標放進標題，不用自己找。
            setTimeout(() => {
                const el = document.querySelector(`.card[data-id="${CSS.escape(newCard.id)}"]`);
                if (!el) return;
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.querySelector('.input-title')?.focus({ preventScroll: true });
                el.classList.add('task-nav-flash');
            }, 60);
        },

        // 標題／內容／專案：每打一個字就存（0.4 秒後統一寫入），不重畫畫面。
        editCardText(id, field, value) {
            if (!['title', 'content', 'project'].includes(field)) return;
            const card = app.worktime.getCard(id);
            if (!card) return;
            card[field] = value;
            app.saveToLocal();
            app.taskNav.scheduleRender();
        },

        // 舊介面相容：一般欄位更新。
        updateCard(id, field, value) {
            const card = app.worktime.getCard(id);
            if (!card) return;
            card[field] = value;
            app.saveToLocal();
            app.refreshCard(id);
        },

        updateCardDate(id, field, value) {
            if (!['dateSingle', 'dateStart', 'dateEnd'].includes(field)) return;
            const card = app.worktime.getCard(id);
            if (!card) return;
            card[field] = value;
            if (card.dateStart && card.dateEnd && card.dateEnd < card.dateStart) {
                if (field === 'dateStart') card.dateEnd = card.dateStart; else card.dateStart = card.dateEnd;
            }
            app.saveToLocal();
            app.refreshCard(id);
        },

        openPlanning(id) {
            const ui = app.worktime.getPlanningUi(id, 'timeline');
            if (!ui.expanded) app.worktime.togglePlanning(id, 'timeline');
            setTimeout(() => document.querySelector(`[data-fk="${CSS.escape(`timeline:${id}:nextStep`)}"]`)?.focus(), 80);
        },

        getCardInTab(id, targetTabId = null) {
            if (targetTabId && app.state.workspaces[targetTabId]) {
                const direct = app.state.workspaces[targetTabId].find(c => c.id === id);
                if (direct) return direct;
            }
            return app.worktime.getCard(id);
        },

        tabOfCard(id) {
            for (const tabId in app.state.workspaces) {
                if ((app.state.workspaces[tabId] || []).some(c => c.id === id)) return tabId;
            }
            return null;
        },

        toggleChronicle(id, targetTabId = null) {
            const card = this.getCardInTab(id, targetTabId);
            if (!card) return;
            card.chroniclePinned = !card.chroniclePinned;
            if (card.chroniclePinned && !card.chronicleDate) card.chronicleDate = app.worktime.localDateString();
            app.saveToLocal();
            if (app.state.view === 'chronicle') app.ui.defer(() => app.renderChronicle());
            else app.refreshCard(id);
            if (card.chroniclePinned) app.ui.toast('已加入大事記，記得到「⚡ 大事記」寫一句摘要');
        },

        updateChronicleMeta(id, field, value, targetTabId = null) {
            if (!['chronicleDate', 'chronicleSummary'].includes(field)) return;
            const card = this.getCardInTab(id, targetTabId);
            if (!card) return;
            card[field] = value;
            app.saveToLocal();
            // 摘要邊打邊存不重畫；改日期才需要重新排序。
            if (field === 'chronicleDate' && app.state.view === 'chronicle') app.ui.defer(() => app.renderChronicle());
        },

        async deleteCard(id, targetTabId = null) {
            const tabId = (targetTabId && app.state.workspaces[targetTabId]?.some(c => c.id === id)) ? targetTabId : this.tabOfCard(id);
            if (!tabId) return;
            const card = app.state.workspaces[tabId].find(c => c.id === id);
            const mins = app.worktime.totalMinutes(card);
            const blank = app.sync.isBlankCard(card);
            if (!blank) {
                const ok = await app.ui.confirm('刪除卡片',
                    `<p>刪除「${app.entries.escapeHtml(card.title || '未命名卡片')}」${mins ? `（含 ${app.worktime.formatMinutes(mins)} 工時紀錄）` : ''}？</p><p>會先放進「🗂 資料 → 最近刪除」，需要時可以救回。</p>`, '刪除', true);
                if (!ok) return;
            }
            const sb = app.state.sandbox;
            if (sb.timerStatus !== 'IDLE' && sb.timerTaskId === id) app.sandbox.stopTimer('心流計時（刪除卡片前結算）');
            // 對話框期間資料可能被更新（另一分頁、雲端載入），重新找一次這張卡。
            const nowTab = this.tabOfCard(id);
            const nowCard = nowTab ? app.state.workspaces[nowTab].find(c => c.id === id) : null;
            if (!nowCard) return;
            if (!await app.backup.trashOrConfirm([{ card: nowCard, tabId: nowTab }], '刪除')) return;
            Object.keys(app.state.workspaces).forEach(t => { app.state.workspaces[t] = app.state.workspaces[t].filter(c => c.id !== id); });
            if (sb.activeTaskId === id) { sb.activeTaskId = null; if (sb.timerStatus === 'IDLE') sb.timerTaskId = null; app.sandbox.persistTimer(); }
            app.saveToLocal();
            app.ui.defer(() => app.renderAll());
            app.ui.toast(blank ? '已移除空白卡片' : '已刪除（可在「🗂 資料 → 最近刪除」救回）');
        },

        jumpToCard(id, tabId) {
            const realTab = (tabId && app.state.workspaces[tabId]?.some(c => c.id === id)) ? tabId : this.tabOfCard(id);
            if (!realTab) return;
            const card = app.worktime.getCard(id);
            app.state.activeTabId = realTab;
            app.state.filters.activeProject = null;
            const project = String(card?.project || '').trim() || '日常雜項 (未分類)';
            const gkey = `${realTab}::${project}`;
            if (app.prefs.collapsedGroups?.[gkey]) { app.prefs.collapsedGroups[gkey] = false; app.store.savePrefs(); }
            app.switchView('timeline');
            setTimeout(() => {
                const targetEl = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
                if (targetEl) {
                    targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    targetEl.classList.remove('task-nav-flash');
                    void targetEl.offsetWidth;
                    targetEl.classList.add('task-nav-flash');
                }
            }, 100);
        },

        moveCard(id, targetTabId) {
            const currentTabId = this.tabOfCard(id);
            if (!currentTabId || currentTabId === targetTabId) return;
            const cardIndex = app.state.workspaces[currentTabId].findIndex(c => c.id === id);
            if (cardIndex === -1) return;
            const [card] = app.state.workspaces[currentTabId].splice(cardIndex, 1);
            if (!app.state.workspaces[targetTabId]) app.state.workspaces[targetTabId] = [];
            app.state.workspaces[targetTabId].push(card);
            app.saveToLocal();
            app.ui.defer(() => app.renderAll());
            app.ui.toast(`已移到「${app.state.tabs.find(t => t.id === targetTabId)?.name || ''}」`);
        },

        cycleStatus(id) {
            const card = app.worktime.getCard(id);
            if (!card) return;
            const current = Number(card.status || 0);
            const next = (current + 1) % 4;
            if (next === 2) app.worktime.markCompleted(card);
            else {
                if (current === 2) app.worktime.reopenCompleted(card, next);
                else card.status = next;
                if (next === 1) app.worktime.ensureStarted(card);
            }
            app.saveToLocal(); app.refreshCard(id);
        },

        cycleColor(id) {
            const card = app.worktime.getCard(id);
            if (!card) return;
            const colors = ['blue', 'green', 'red', 'yellow'];
            card.color = colors[(colors.indexOf(card.color) + 1) % colors.length];
            app.saveToLocal(); app.refreshCard(id);
        },

        toggleMemo(id) {
            const card = app.worktime.getCard(id);
            if (!card) return;
            card.isMemo = !card.isMemo;
            if (!card.isMemo && !app.worktime.plannedStart(card)) {
                const today = app.worktime.localDateString();
                card.dateMode = 'range'; card.dateStart = today; card.dateEnd = today;
            }
            app.saveToLocal(); app.refreshCard(id);
        },

        toggleDateMode(id) {
            const card = app.worktime.getCard(id);
            if (!card) return;
            const W = app.worktime;
            if (card.dateMode === 'single') {
                const d = card.dateSingle || W.localDateString();
                card.dateMode = 'range';
                if (!card.dateStart) card.dateStart = d;
                if (!card.dateEnd) card.dateEnd = card.dateStart;
            } else {
                card.dateMode = 'single';
                if (!card.dateSingle) card.dateSingle = card.dateStart || W.localDateString();
            }
            app.saveToLocal(); app.refreshCard(id);
        },

        addMatrixNode() {
            const inputEl = document.getElementById('matrix-quick-input'); const tagEl = document.getElementById('matrix-tag-select');
            const text = inputEl.value.trim(); if (!text) return;
            if (!app.state.nodes[app.state.activeTabId]) app.state.nodes[app.state.activeTabId] = [];
            const gridX = Math.floor(Math.random() * 7) + 6; const gridY = Math.floor(Math.random() * 7) + 6;
            app.state.nodes[app.state.activeTabId].push({ id: app.makeId('node'), text, tag: tagEl.value, gridX, gridY, stoneColor: 'white', project: app.state.filters.activeProject || '' });
            inputEl.value = ''; app.saveToLocal(); app.renderMatrix();
        },
        updateMatrixNodePos(id, gridX, gridY) { const node = (app.state.nodes[app.state.activeTabId] || []).find(n => n.id === id); if (node) { node.gridX = gridX; node.gridY = gridY; app.saveToLocal(); app.renderMatrix(); } },
        toggleStoneColor(id) { const node = (app.state.nodes[app.state.activeTabId] || []).find(n => n.id === id); if (node) { node.stoneColor = node.stoneColor === 'black' ? 'white' : 'black'; app.saveToLocal(); app.renderMatrix(); } },
        deleteMatrixNode(id) { app.state.nodes[app.state.activeTabId] = (app.state.nodes[app.state.activeTabId] || []).filter(n => n.id !== id); app.saveToLocal(); app.renderMatrix(); },
        promoteToCard(id) {
            const nodes = app.state.nodes[app.state.activeTabId] || []; const idx = nodes.findIndex(n => n.id === id); if (idx === -1) return;
            const node = nodes[idx]; let cardColor = 'blue';
            if (node.tag === 'q1') cardColor = 'red'; else if (node.tag === 'q3') cardColor = 'yellow'; else if (node.tag === 'q2') cardColor = 'green';
            app.state.workspaces[app.state.activeTabId].push({ id: app.makeId('card'), title: node.text, content: '', project: node.project || '', dateMode: 'single', dateSingle: app.worktime.localDateString(), color: cardColor, status: 0, isMemo: false });
            nodes.splice(idx, 1); app.saveToLocal(); app.renderAll(); app.ui.toast('🚀 已轉為排程卡片，到「📜 時間軸」可以看到');
        },

        switchTab(id) {
            app.state.activeTabId = id;
            app.state.filters.activeProject = null;
            app.rememberPrefs();
            if (app.state.view === 'sandbox') { app.renderTabs(); app.sandbox.renderTodo(); app.sandbox.refreshActiveNoteUI(); }
            else app.renderAll();
        },
        addTab() {
            const name = prompt("請輸入新工作區名稱：");
            if (!name || !name.trim()) return;
            const id = app.makeId('tab');
            app.state.tabs.push({ id, name: name.trim() }); app.state.workspaces[id] = []; app.state.nodes[id] = [];
            app.state.activeTabId = id; app.saveToLocal(); app.rememberPrefs(); app.renderAll();
        },
        async manageTab(e, id) {
            e?.preventDefault?.();
            app.tabsManager.open(id);
            return;
            if (id === 'main') { app.ui.toast('「主工作區」無法修改或刪除'); return; }
            const tab = app.state.tabs.find(t => t.id === id);
            if (!tab) return;
            const cards = app.state.workspaces[id] || [];
            const action = await app.ui.dialog({
                title: `工作區「${tab.name}」`,
                html: `<p>這個工作區有 ${cards.length} 張卡片。</p>`,
                buttons: [{ label: '取消', value: null }, { label: '刪除工作區…', value: 'delete', danger: true }, { label: '重新命名', value: 'rename', primary: true }]
            });
            if (action === 'rename') {
                const newName = prompt('請輸入新名稱：', tab.name);
                if (newName && newName.trim()) { tab.name = newName.trim(); app.saveToLocal(); app.renderAll(); }
            } else if (action === 'delete') {
                const mins = cards.reduce((sum, c) => sum + app.worktime.totalMinutes(c), 0);
                const ok = await app.ui.confirm('刪除工作區', `<p>刪除「${app.entries.escapeHtml(tab.name)}」與裡面的 <b>${cards.length}</b> 張卡片${mins ? `（${app.worktime.formatMinutes(mins)} 工時）` : ''}？</p><p>卡片會先放進「最近刪除」。</p>`, '刪除', true);
                if (!ok) return;
                const sb = app.state.sandbox;
                if (sb.timerStatus !== 'IDLE' && cards.some(c => c.id === sb.timerTaskId)) app.sandbox.stopTimer();
                if (!await app.backup.trashOrConfirm(cards.map(card => ({ card, tabId: id })), `刪除工作區「${tab.name}」`)) return;
                app.state.tabs = app.state.tabs.filter(t => t.id !== id);
                delete app.state.workspaces[id]; delete app.state.nodes[id];
                app.state.activeTabId = 'main';
                app.saveToLocal(); app.rememberPrefs(); app.renderAll();
            }
        },
        updateNotebookTemplate(val) { app.state.globalNotebook.template = val; app.saveToLocal(); app.renderNotebookArea(); },
        updateNotebook(field, val) {
            if (field === 'free') app.state.globalNotebook.free = val;
            else { const key = field.split('.')[1]; if (!app.state.globalNotebook.matrix) app.state.globalNotebook.matrix = {}; app.state.globalNotebook.matrix[key] = val; }
            app.saveToLocal();
            if (field === 'free' && app.state.view === 'sandbox' && !app.state.sandbox.activeTaskId) {
                const area = document.getElementById('sb-activeNoteArea');
                if (area && document.activeElement !== area) area.value = val;
            }
        },

        setTsumegoColor(color) {
            app.state.tsumego.currentColor = color;
            document.querySelectorAll('.tsumego-tool-btn').forEach(btn => btn.classList.remove('active'));
            document.getElementById('ts-btn-' + color)?.classList.add('active');
        },
        placeTsumegoStone(e) {
            const gridBox = document.getElementById('tsumego-grid-lines'); const rect = gridBox.getBoundingClientRect();
            const rawX = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left; const rawY = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
            const gridX = Math.round((rawX / rect.width) * 18); const gridY = Math.round((rawY / rect.height) * 18);
            if (gridX < 0 || gridX > 18 || gridY < 0 || gridY > 18) return;
            const stones = app.state.tsumego.stones;
            const existingIdx = stones.findIndex(s => s.x === gridX && s.y === gridY);
            if (app.state.tsumego.currentColor === 'clear') { if (existingIdx > -1) stones.splice(existingIdx, 1); }
            else if (existingIdx > -1) stones[existingIdx].color = app.state.tsumego.currentColor;
            else stones.push({ x: gridX, y: gridY, color: app.state.tsumego.currentColor });
            app.saveToLocal(); app.renderTsumegoStones();
        },
        async resetTsumego() { if (await app.ui.confirm('清空盤面', '<p>確定要清空詰棋盤面？</p>', '清空', true)) { app.state.tsumego.stones = []; app.saveToLocal(); app.renderTsumegoStones(); } }
    }
};

// ==========================================
// 🧭 v2.2.1 任務導覽
// 與既有 app 核心解耦：不改 renderAll / jumpToCard / Firebase。
// ==========================================
app.taskNav = {
    ui: {
        initialized: false,
        open: false,
        search: '',
        scope: 'current',
        activeCardId: null,
        lastMobile: null,
        collapsedGroups: Object.create(null),
        timelineObserver: null,
        mutationObserver: null,
        renderTimer: null
    },

    isMobile() { return window.innerWidth <= 768; },
    defaultOpen() { return window.innerWidth > 1200; },

    safe(fn) {
        try { return fn(); }
        catch (err) { console.warn('[taskNav] 導覽功能發生錯誤，核心白板不受影響：', err); return null; }
    },

    init() {
        if (this.ui.initialized) return;
        this.ui.initialized = true;
        this.ui.lastMobile = this.isMobile();
        this.ui.open = this.defaultOpen();
        this.applyOpenState();
        this.safe(() => this.renderList());
        this.installMutationObserver();
        this.safe(() => this.observeTimelineCards());

        window.addEventListener('resize', () => this.safe(() => {
            const mobileNow = this.isMobile();
            if (mobileNow !== this.ui.lastMobile) {
                this.ui.lastMobile = mobileNow;
                this.ui.open = this.defaultOpen();
                this.applyOpenState();
            }
            this.observeTimelineCards();
        }));
    },

    applyOpenState() {
        document.body.classList.toggle('task-nav-open', !!this.ui.open);
        document.getElementById('btn-task-nav')?.classList.toggle('active', !!this.ui.open);
    },

    toggle() {
        this.ui.open = !this.ui.open;
        this.applyOpenState();
        if (this.ui.open) {
            this.safe(() => this.renderList());
            this.safe(() => this.observeTimelineCards());
            if (this.isMobile()) setTimeout(() => document.getElementById('task-nav-search')?.focus(), 180);
        }
    },

    close() { this.ui.open = false; this.applyOpenState(); },

    // 打字改標題時，導覽列稍後再更新（不跟著每個字重畫）。
    scheduleRender() {
        clearTimeout(this.ui.renderTimer);
        this.ui.renderTimer = setTimeout(() => this.safe(() => this.renderList()), 400);
    },

    setSearch(value) {
        this.ui.search = String(value || '');
        this.safe(() => this.renderList());
    },

    setScope(value) {
        this.ui.scope = value === 'all' ? 'all' : 'current';
        this.safe(() => this.renderList());
    },

    normalizeText(value) { return String(value ?? '').toLocaleLowerCase('zh-TW').trim(); },
    escape(value) {
        if (app.entries && typeof app.entries.escapeHtml === 'function') return app.entries.escapeHtml(value);
        return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    },

    getTabs() {
        const tabs = Array.isArray(app.state.tabs) ? app.state.tabs : [];
        return this.ui.scope === 'all' ? tabs : tabs.filter(t => t.id === app.state.activeTabId);
    },

    renderList() {
        const root = document.getElementById('task-nav-list');
        if (!root) return;
        const searchEl = document.getElementById('task-nav-search');
        const scopeEl = document.getElementById('task-nav-scope');
        if (searchEl && searchEl.value !== this.ui.search) searchEl.value = this.ui.search;
        if (scopeEl) scopeEl.value = this.ui.scope;

        const q = this.normalizeText(this.ui.search);
        const sections = [];

        this.getTabs().forEach(tab => {
            const sourceCards = Array.isArray(app.state.workspaces?.[tab.id]) ? app.state.workspaces[tab.id] : [];
            const cards = q ? sourceCards.filter(card => {
                const hay = [tab.name, card.project, card.category, card.title, card.content]
                    .map(v => this.normalizeText(v)).join(' ');
                return hay.includes(q);
            }) : sourceCards;
            if (!cards.length) return;

            const groups = new Map();
            cards.forEach(card => {
                const project = String(card.project || '').trim() || '未分類';
                if (!groups.has(project)) groups.set(project, []);
                groups.get(project).push(card);
            });

            let groupHtml = '';
            groups.forEach((groupCards, project) => {
                const groupKey = `${tab.id}::${project}`;
                const collapsed = !!this.ui.collapsedGroups[groupKey];
                const rows = groupCards.map(card => {
                    const active = this.ui.activeCardId === card.id ? ' active' : '';
                    const titleRaw = String(card.title || '').trim() || '未命名卡片';
                    const title = this.escape(titleRaw);
                    const kind = card.isMemo ? '自由' : '排程';
                    return `<button type="button" class="task-nav-card status-${Number(card.status || 0)}${active}" data-card-id="${this.escape(card.id)}" onclick="app.taskNav.goToCard('${card.id}','${tab.id}')" title="${title}">
                        <span class="task-nav-card-dot"></span><span class="task-nav-card-title">${title}</span><span class="task-nav-card-kind">${kind}</span>
                    </button>`;
                }).join('');

                groupHtml += `<div class="task-nav-project${collapsed ? ' collapsed' : ''}" data-group-key="${this.escape(groupKey)}">
                    <button type="button" class="task-nav-project-head" onclick="app.taskNav.toggleProject('${this.escape(groupKey)}', this)">
                        <span class="task-nav-project-arrow">${collapsed ? '▶' : '▼'}</span>
                        <span class="task-nav-project-name">${this.escape(project)}</span>
                        <span class="task-nav-project-count">${groupCards.length}</span>
                    </button>
                    <div class="task-nav-card-list">${rows}</div>
                </div>`;
            });

            sections.push(`<section class="task-nav-workspace">
                <div class="task-nav-workspace-title">▣ ${this.escape(tab.name || '工作區')}${tab.id === app.state.activeTabId ? ' · 目前' : ''}</div>
                ${groupHtml}
            </section>`);
        });

        root.innerHTML = sections.length ? sections.join('') : `<div class="task-nav-empty">${q ? '找不到符合的卡片。' : '目前沒有可導覽的卡片。'}</div>`;
    },

    toggleProject(groupKey, button) {
        const project = button?.closest('.task-nav-project');
        if (!project) return;
        const collapsed = !project.classList.contains('collapsed');
        project.classList.toggle('collapsed', collapsed);
        const arrow = project.querySelector('.task-nav-project-arrow');
        if (arrow) arrow.textContent = collapsed ? '▶' : '▼';
        this.ui.collapsedGroups[groupKey] = collapsed;
    },

    goToCard(cardId, tabId) {
        this.ui.activeCardId = cardId;
        // 使用 v2.1 既有跳轉機制，不改它本身。
        app.actions.jumpToCard(cardId, tabId);
        if (this.isMobile()) this.close();
        setTimeout(() => this.safe(() => {
            this.setActiveCard(cardId);
            this.observeTimelineCards();
            const target = document.querySelector(`.card[data-id="${CSS.escape(cardId)}"]`);
            if (target) {
                target.classList.remove('task-nav-flash');
                void target.offsetWidth;
                target.classList.add('task-nav-flash');
            }
        }), 220);
    },

    setActiveCard(cardId) {
        if (!cardId) return;
        this.ui.activeCardId = cardId;
        document.querySelectorAll('#task-nav-list .task-nav-card.active').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('#task-nav-list .task-nav-card').forEach(el => {
            if (el.dataset.cardId !== cardId) return;
            el.classList.add('active');
            const project = el.closest('.task-nav-project');
            if (project?.classList.contains('collapsed')) {
                project.classList.remove('collapsed');
                const arrow = project.querySelector('.task-nav-project-arrow');
                if (arrow) arrow.textContent = '▼';
                const key = project.dataset.groupKey;
                if (key) this.ui.collapsedGroups[key] = false;
            }
            if (this.ui.open && !this.isMobile()) el.scrollIntoView({block:'nearest'});
        });
    },

    disconnectTimelineObserver() {
        if (this.ui.timelineObserver) this.ui.timelineObserver.disconnect();
        this.ui.timelineObserver = null;
    },

    observeTimelineCards() {
        this.disconnectTimelineObserver();
        if (app.state.view !== 'timeline' || !('IntersectionObserver' in window)) return;
        const cards = [...document.querySelectorAll('#timeline-render-target .card[data-id]')];
        if (!cards.length) return;
        this.ui.timelineObserver = new IntersectionObserver(entries => {
            const visible = entries.filter(e => e.isIntersecting);
            if (!visible.length) return;
            visible.sort((a,b) => Math.abs(a.boundingClientRect.top - innerHeight * .33) - Math.abs(b.boundingClientRect.top - innerHeight * .33));
            const id = visible[0]?.target?.dataset?.id;
            if (id && id !== this.ui.activeCardId) this.safe(() => this.setActiveCard(id));
        }, { threshold:[0,.05,.2,.5], rootMargin:'-18% 0px -58% 0px' });
        cards.forEach(card => this.ui.timelineObserver.observe(card));
    },

    installMutationObserver() {
        if (!('MutationObserver' in window)) return;
        const targets = [document.getElementById('timeline-render-target'), document.getElementById('tab-bar')].filter(Boolean);
        if (!targets.length) return;
        this.ui.mutationObserver = new MutationObserver(() => {
            clearTimeout(this.ui.renderTimer);
            this.ui.renderTimer = setTimeout(() => this.safe(() => {
                this.renderList();
                this.observeTimelineCards();
            }), 60);
        });
        targets.forEach(target => this.ui.mutationObserver.observe(target, {childList:true, subtree:true}));
    }
};

// === 啟動應用 ===
app.init();
app.taskNav.init();
