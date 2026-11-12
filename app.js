// =====================================================================
// 白板 & 心流沙盒 v6.7
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

const APP_VERSION = '6.7';
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
// 公司專案清單：可在「週報／日誌 → 給 AI 的設定」自己改；沒改過就用預設
function companyProjects() {
    const saved = typeof app !== 'undefined' && app.settings ? app.settings.get('companyProjects') : null;
    const list = Array.isArray(saved) ? saved.map(x => String(x || '').trim()).filter(Boolean) : [];
    return list.length ? list : COMPANY_PROJECTS;
}
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
        view: 'today',
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
        // Alt+N：任何畫面都能快速新增卡片
        document.addEventListener('keydown', e => {
            if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyN' && !document.querySelector('.app-dialog-overlay')) { e.preventDefault(); app.quickAdd.open(); }
        });
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
                // 從 Project Lab 的「♟ 到白板棋盤調整」連過來：?board=卡片id
                try {
                    const bid = new URLSearchParams(location.search).get('board');
                    if (bid && this.worktime.getCard(bid)) {
                        setTimeout(() => this.board.open(bid), 0);
                        const u = new URL(location.href); u.searchParams.delete('board'); history.replaceState(null, '', u.pathname + u.search + u.hash);
                    }
                } catch (_) {}
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
        // 首頁＝今日：每次打開都從今日開始
        s.view = 'today';
        if (this.taskNav?.ui?.initialized && this.taskNav.ui.open) { this.taskNav.ui.open = false; this.taskNav.applyOpenState(); }
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
                sandbox: { deadlineTask: s.sandbox.deadlineTask, deadlineDate: s.sandbox.deadlineDate, settings: s.sandbox.settings || '', daylog: s.sandbox.daylog || '', projects: s.sandbox.projects || '' },
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
            s.sandbox.settings = doc.sandbox.settings || '';
            s.sandbox.daylog = doc.sandbox.daylog || '';
            s.sandbox.projects = doc.sandbox.projects || '';
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
            const misc = JSON.stringify([s.tabs, s.globalNotebook, s.tsumego.stones, s.sandbox.deadlineTask, s.sandbox.deadlineDate, s.sandbox.settings || '', s.sandbox.daylog || '', s.sandbox.projects || '']);
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
                    ['title', 'content', 'project', 'category', 'deliverable', 'acceptance', 'nextStep', 'nextAction', 'waitingWho', 'waitingWhat', 'followUpDate', 'docUrl', 'parentId',
                     'chronicleSummary', 'chronicleDate', 'dateStart', 'dateEnd', 'dateSingle', 'actualStart', 'actualEnd', 'timeCategory', 'dateMode', 'color'].forEach(k => {
                        if (card[k] !== undefined && card[k] !== null && typeof card[k] !== 'string') card[k] = String(card[k]);
                    });
                    if (typeof card.project === 'string' && card.project !== card.project.trim()) card.project = card.project.trim();
                    if (typeof card.content === 'string' && /(^|\n)\s*(❓|💬)/.test(card.content)) {
                        card.content = card.content.split('\n').map(l => {
                            const t = l.trim();
                            if (t.startsWith('❓')) return `- [?] ${t.replace(/^❓\uFE0F?/, '').trim()}`;
                            if (t.startsWith('💬')) return `- [A] ${t.replace(/^💬\uFE0F?/, '').trim()}`;
                            return l;
                        }).join('\n');
                    }
                    if (card.title === undefined || card.title === null) card.title = '';
                    if (card.content === undefined || card.content === null) card.content = '';
                    if (card.project === undefined || card.project === null) card.project = '';
                    if (card.workLogs !== undefined) card.workLogs = Array.isArray(card.workLogs) ? fixListIds(card.workLogs, 'work', card.id) : [];
                    if (card.entries !== undefined) card.entries = Array.isArray(card.entries) ? fixListIds(card.entries, 'entry', card.id) : [];
                    if (card.refs !== undefined) card.refs = Array.isArray(card.refs) ? fixListIds(card.refs, 'ref', card.id) : [];
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
                deadlineDate: String(src.sandbox?.deadlineDate ?? ''),
                settings: typeof src.sandbox?.settings === 'string' ? src.sandbox.settings : '',
                daylog: typeof src.sandbox?.daylog === 'string' ? src.sandbox.daylog : '',
                projects: typeof src.sandbox?.projects === 'string' ? src.sandbox.projects : ''
            };
            if (!withFlag) return out;
            return { doc: out, changed: JSON.stringify([out.tabs, out.workspaces, out.nodes]) !== before };
        }
    },

    // 「關於我」：每次交給 AI 都帶上（不用叫 AI 扮演誰，給它情境就好）。Project Lab 也會讀這一段。
    aiAbout() { return String(app.settings?.get('aiAbout') || '').trim(); },
    aiText(text) { const a = app.aiAbout(); return a ? `【關於我】\n${a}\n\n${text}` : text; },
    aiAboutField() {
        return `<div class="data-note"><b>關於我</b>（每次交給 AI 都會帶在最前面；Project Lab 也會用）。寫你的工作、常見情況、希望 AI 怎麼回，三五行就好。</div>
            <textarea class="task-meta-textarea" rows="4" placeholder="我是網站維運標案的 PM，同時跟好幾個政府單位（化學署、環境部）。&#10;常被臨時會議和長官要資料打斷，上午比較能專心。&#10;我想學的是拆解和回報進度。&#10;回答請簡短、條列，判斷不了先問我，不要自己補成事實。" onchange="app.settings.set('aiAbout', this.value.trim())">${app.entries.escapeHtml(app.aiAbout())}</textarea>`;
    },

    // 跟著雲端同步的設定（時段、可專心時數、公司專案清單、專案名稱對照）。沒設過的沿用這台電腦以前的值。
    settings: {
        KEYS: ['todaySlots', 'todayBudget', 'companyProjects', 'companyProjectMap', 'aiAbout', 'trelloTemplate', 'boardZones'],
        all() { try { const v = JSON.parse(app.state.sandbox.settings || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } },
        get(k) { const v = this.all(); return v[k] !== undefined ? v[k] : app.prefs?.[k]; },
        set(k, val) {
            const v = this.all();
            if (val === undefined) delete v[k]; else v[k] = val;
            app.state.sandbox.settings = JSON.stringify(v);
            app.saveToLocal();
        }
    },

    // 專案表：卡片上仍存專案名稱（文字），這裡另記每個專案的公司標案、狀態、截止日。改名＝所有卡片一起改。
    projectReg: {
        all() { try { const v = JSON.parse(app.state.sandbox.projects || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } },
        save(v) { app.state.sandbox.projects = JSON.stringify(v); app.saveToLocal(); },
        get(name) { return this.all()[String(name || '').trim()] || {}; },
        set(name, patch) { const n = String(name || '').trim(); if (!n) return; const v = this.all(); v[n] = { ...(v[n] || {}), ...patch }; this.save(v); },
        isClosed(name) { return this.get(name).status === 'closed'; },
        // 卡片上出現過的名稱＋表裡登記的名稱
        names() { return [...new Set([...app.lists.projects(), ...Object.keys(this.all())])].sort((a, b) => a.localeCompare(b, 'zh-Hant')); },
        cardsOf(name) { const n = String(name || '').trim(); return app.worktime.allCards().filter(({ card }) => String(card.project || '').trim() === n); },
        rename(from, to) {
            const a = String(from || '').trim(), b = String(to || '').trim();
            if (!a || !b || a === b) return 0;
            const rows = this.cardsOf(a);
            rows.forEach(({ card }) => { card.project = b; });
            const v = this.all();
            if (v[a]) { v[b] = { ...v[a], ...(v[b] || {}) }; delete v[a]; }
            this.save(v);
            return rows.length;
        },
        remove(name) { const v = this.all(); delete v[String(name || '').trim()]; this.save(v); },
        // 給公司工時表 AI 用：專案 → 公司標案
        mappingLines() { return Object.entries(this.all()).filter(([, p]) => p.company).map(([n, p]) => `${n} = ${p.company}`); }
    },

    // 每天的收工紀錄（精神時段、反思、計畫 vs 實際摘要），跟著雲端同步；只留 180 天
    daylog: {
        all() { try { const v = JSON.parse(app.state.sandbox.daylog || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } },
        get(date) { return this.all()[date] || {}; },
        set(date, patch) {
            const v = this.all();
            v[date] = { ...(v[date] || {}), ...patch };
            const keep = app.today.addDays(app.today.todayStr(), -180);
            Object.keys(v).forEach(d => { if (d < keep) delete v[d]; });
            app.state.sandbox.daylog = JSON.stringify(v);
            app.saveToLocal();
        }
    },

    // 卡片顯示名稱：沒有標題時用筆記第一行，讓「未命名」也認得出來
    cardLabel(card) {
        const t = String(card?.title || '').trim().split('\n')[0];
        if (t) return t;
        const line = String(card?.content || '').split('\n').map(l => l.replace(/^\s*(?:[-*•]\s+(?:\[[ xX?aA]\]\s*)?|#+\s*|\*\*\[[^\]]*\]\*\*\s*)/, '').trim()).find(Boolean);
        return line ? `（未命名）${line.length > 24 ? line.slice(0, 24) + '…' : line}` : '未命名';
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
        FIELD_LABELS: { followUpDate: '追蹤日', status: '狀態', color: '標記', dateSingle: '日期', dateStart: '開始日', dateEnd: '結束日', dateMode: '日期模式', isMemo: '卡片用途', progress: '進度', plannedMinutes: '預估工時', actualStart: '實際開始', actualEnd: '實際完成', chroniclePinned: '大事記', chronicleDate: '大事記日期', excludeFromGantt: '甘特顯示', listOrder: '清單排序' },
        BLOCK_TEXT: ['content', 'deliverable', 'acceptance', 'chronicleSummary'],
        LIST_FIELDS: ['workLogs', 'entries', 'refs'],

        isBlankCard(c) {
            return !String(c?.title || '').trim() && !String(c?.content || '').trim()
                && !(c?.workLogs || []).length && !(c?.entries || []).length && !(c?.refs || []).length
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
                deadlineTask: doc.sandbox?.deadlineTask, deadlineDate: doc.sandbox?.deadlineDate,
                settings: doc.sandbox?.settings || '',
                daylog: doc.sandbox?.daylog || '',
                projects: doc.sandbox?.projects || ''
            };
        },

        // 「上次和雲端一致時」的指紋，用來判斷是哪一邊改了什麼。只存在本機。
        buildBase(docRaw) {
            const doc = app.migrate.normalize(docRaw);
            const cards = {};
            Object.entries(doc.workspaces).forEach(([tabId, list]) => list.forEach(c => {
                const f = {};
                Object.keys(c).forEach(k => { if (k !== 'updatedAt' && !this.LIST_FIELDS.includes(k)) f[k] = this.fieldHash(c[k]); });
                cards[c.id] = { h: this.cardHash(c), tab: tabId, f, logs: (c.workLogs || []).map(x => x?.id).filter(Boolean), entries: (c.entries || []).map(x => x?.id).filter(Boolean), refs: (c.refs || []).map(x => x?.id).filter(Boolean) };
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
                const v = this.mergeList(a[k], b[k], bc ? ({ workLogs: bc.logs, entries: bc.entries, refs: bc.refs })[k] || null : null, aWins);
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
            const miscLabels = { template: '筆記本模式', free: '全域筆記', q1: '四象限：重要緊急', q2: '四象限：重要不急', q3: '四象限：緊急不重', q4: '四象限：不重不急', stones: '詰棋盤', deadlineTask: '死線倒數名稱', deadlineDate: '死線倒數日期', settings: '設定（時段、公司專案清單）', daylog: '收工帳單', projects: '專案表' };
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
                sandbox: { deadlineTask: mm.deadlineTask ?? '', deadlineDate: mm.deadlineDate ?? '', settings: mm.settings ?? '', daylog: mm.daylog ?? '', projects: mm.projects ?? '' },
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
            const before = app.wsGuard.snap();
            try { return await this._load(); }
            finally { app.wsGuard.check(before, '載入雲端'); }
        },
        async _load() {
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
    // 🛡 工作區保護：任何會整批換掉資料的動作（載入雲端、還原）之後，檢查工作區有沒有消失或卡片大量減少
    wsGuard: {
        snap() {
            const st = app.state || {};
            return (st.tabs || []).map(t => ({ id: t.id, name: t.name, n: (st.workspaces?.[t.id] || []).length }));
        },
        async check(before, action) {
            try {
                const now = this.snap(), byId = Object.fromEntries(now.map(t => [t.id, t]));
                const gone = before.filter(t => !byId[t.id]);
                const shrunk = before.filter(t => byId[t.id] && t.n >= 5 && byId[t.id].n < t.n * 0.5);
                if (!gone.length && !shrunk.length) return;
                const esc = x => app.entries.escapeHtml(x);
                await app.ui.dialog({
                    title: '🛡 工作區有大變化，請確認',
                    html: `<p>「${esc(action)}」之後：</p><ul>
                        ${gone.map(t => `<li>工作區「<b>${esc(t.name)}</b>」不見了（原本 ${t.n} 張卡）</li>`).join('')}
                        ${shrunk.map(t => `<li>「<b>${esc(t.name)}</b>」從 ${t.n} 張變成 ${byId[t.id].n} 張</li>`).join('')}</ul>
                        <p>如果這不是你要的：到「🗂 資料 → 本機快照」，還原「${esc(action)}前」的版本就回來了。</p>`,
                    buttons: [{ label: '知道了', value: true }, { label: '打開 🗂 資料', value: 'data', primary: true }]
                }).then(v => { if (v === 'data') app.dataCenter.open(); });
            } catch (e) { console.warn(e); }
        }
    },

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
            window.addEventListener('beforeunload', e => {
                app.store.flush(); app.sandbox.persistTimer();
                // 還有修改沒上傳：瀏覽器會先問要不要離開（手動同步的提醒）
                if (app.currentUser && app.cloud.hasUnsynced()) { e.preventDefault(); e.returnValue = ''; }
            });
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
            if (!target) return;
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

        lastExport() { try { return Number(localStorage.getItem('whiteboard_last_export')) || 0; } catch (_) { return 0; } },
        exportJson() {
            try { localStorage.setItem('whiteboard_last_export', String(Date.now())); localStorage.removeItem('whiteboard_backup_snooze'); } catch (_) {}
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
            container.innerHTML = `${app.worktime.renderPlanningPanel(card, 'sandbox')}<div style="height:8px"></div>${app.refs.render(card, 'sandbox')}<div style="height:8px"></div>${app.worktime.renderPanel(card, 'sandbox')}<div style="height:8px"></div><div class="worklog-panel" id="worklog-panel-sandbox-${card.id}">${this.renderPanelInner(card, 'sandbox')}</div>`;
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
            if (card.parentId) app.board?.syncParent(card);
        },

        reopenCompleted(card, preferredStatus = null) {
            if (!card || Number(card.status) !== 2) return;
            if (Number(card.progress) >= 100) delete card.progress;
            delete card.actualEnd;
            if (preferredStatus !== null) card.status = Number(preferredStatus);
            else card.status = (this.totalMinutes(card) > 0 || !!card.actualStart) ? 1 : 0;
            if (card.parentId) app.board?.syncParent(card);
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
                        ${card.docUrl ? `<a class="pm-doc-link" href="${esc(app.refs.href(card.docUrl))}" target="_blank" rel="noopener" title="${esc(card.docUrl)}">📁 Trello／文件</a>` : ''}
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
                                <span style="display:flex;gap:6px;flex-wrap:wrap;">
                                    <button type="button" class="worklog-add-btn" onclick="app.gcal.open('${id}')" title="打開 Google 日曆新增活動">📅 加到日曆${card.calendarAddedAt ? ' ✓' : ''}</button>
                                    <button type="button" class="worklog-add-btn" onclick="app.coach.open({ template: 'fill', cardId: '${id}' })">🧑‍🏫 請 AI 先填一版</button>
                                </span>
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
                            ${source === 'sandbox' ? '' : `<label class="task-meta-field" style="margin-top:8px;">
                                <span class="task-meta-label">➡ 下一步 <span class="pm-hint">（回到這張卡時，從哪裡接）</span></span>
                                <input class="task-meta-input" ${fk('nextStep')} value="${esc(card.nextStep || '')}" placeholder="例如：拿正式資料跑一次，確認圖表定位規則" oninput="app.worktime.editText('${id}','nextStep',this.value,'${source}')">
                            </label>`}
                            <div class="waiting-box ${waitingSet ? 'active' : ''}">
                                <div class="task-meta-label">⏳ 在等別人？ <span class="pm-hint">（寫清楚等誰、等什麼、哪天要追，週報會自動列出來）</span></div>
                                <div class="task-meta-grid" style="grid-template-columns:1fr 1.6fr 140px auto;margin-top:4px;">
                                    <input class="task-meta-input" ${fk('waitingWho')} value="${esc(card.waitingWho || '')}" placeholder="等誰" oninput="app.worktime.editText('${id}','waitingWho',this.value,'${source}')">
                                    <input class="task-meta-input" ${fk('waitingWhat')} value="${esc(card.waitingWhat || '')}" placeholder="等什麼（例如：確認規格、提供資料）" oninput="app.worktime.editText('${id}','waitingWhat',this.value,'${source}')">
                                    <input class="task-meta-input" ${fk('followUpDate')} type="date" value="${esc(card.followUpDate || '')}" title="哪天要追" onchange="app.worktime.updateCardField('${id}','followUpDate',this.value,'${source}')">
                                    ${waitingSet ? `<span style="display:flex;gap:4px;"><button type="button" class="worklog-action-btn" onclick="app.gcal.followUp('${id}')" title="在追蹤日加一個提醒到 Google 日曆">📅 提醒</button><button type="button" class="worklog-action-btn" onclick="app.worktime.clearWaiting('${id}','${source}')" title="已收到回覆，清除等待">✓ 收到了</button></span>` : '<span></span>'}
                                </div>
                            </div>
                            <div class="doc-box">
                                <span class="task-meta-label">📁 Trello／文件</span>
                                <input class="task-meta-input" ${fk('docUrl')} value="${esc(card.docUrl || '')}" placeholder="貼上 Trello 卡或文件的網址（脈絡、圖片放那邊）" oninput="app.worktime.editText('${id}','docUrl',this.value,'${source}')">
                                ${card.docUrl ? `<a class="worklog-action-btn" href="${esc(app.refs.href(card.docUrl))}" target="_blank" rel="noopener" title="打開">↗</a>` : ''}
                                <button type="button" class="worklog-action-btn" onclick="app.docRecord.open('${id}')" title="把這張卡的筆記、待辦、問答、工時整理成一份紀錄，請 AI 照格式寫，貼到 Trello">📝 整理成 Trello 紀錄</button>
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
            this._forceFocus = id;
            app.switchView('sandbox');
            this.switchLeftPanel('TIMER');
            this.setActiveTask(id);
            const card = app.worktime.getCard(id);
            app.ui.toast(`🎯 專注在「${String(card?.title || '').trim() || '未命名'}」，按 ▶ 開始計時`);
        },

        // 從其他畫面進心流時：計時中就專注計時的卡；否則專注「這個工作區最近新增或編輯的卡」。
        autoFocus() {
            const sb = app.state.sandbox;
            if (this._forceFocus) { this._forceFocus = null; return; }
            if (sb.timerStatus !== 'IDLE' && sb.timerTaskId && app.worktime.getCard(sb.timerTaskId)) {
                if (sb.activeTaskId !== sb.timerTaskId) { sb.activeTaskId = sb.timerTaskId; this.persistTimer(); }
                return;
            }
            const cards = this.getActiveCards().filter(c => Number(c.status) !== 2);
            if (!cards.length) return;
            const touched = c => Math.max(Number(c.updatedAt) || 0, app.idTime(c.id) || 0);
            const latest = cards.reduce((a, b) => touched(b) > touched(a) ? b : a);
            const current = sb.activeTaskId ? app.worktime.getCard(sb.activeTaskId) : null;
            const inThisTab = current && cards.some(c => c.id === current.id);
            if (!inThisTab || touched(latest) > touched(current)) {
                sb.activeTaskId = latest.id;
                sb.timerTaskId = latest.id;
                this.persistTimer();
            }
        },

        refreshActiveNoteUI() {
            const titleEl = document.getElementById('sb-activeTaskTitle');
            const iconEl = document.getElementById('sb-activeTaskIcon');
            const noteArea = document.getElementById('sb-activeNoteArea');
            const nextStepBox = document.getElementById('sb-nextStepBox');
            const nextStepInput = document.getElementById('sb-nextStepInput');
            if (!titleEl || !noteArea) return;
            this._lastCaret = null; // 換卡：還沒點過筆記，插入時放在最後
            const card = this.activeCard();
            if (card) {
                iconEl.style.display = 'inline'; titleEl.value = card.title || ''; titleEl.style.color = 'var(--primary)';
                titleEl.readOnly = false; noteArea.value = card.content || "";
                if (nextStepBox) nextStepBox.style.display = 'block';
                if (nextStepInput) nextStepInput.value = card.nextStep || '';
                app.entries.renderSandbox(card);
                this.renderCountdown();
                return;
            }
            app.state.sandbox.activeTaskId = null;
            iconEl.style.display = 'none'; titleEl.value = "📝 全域沙盒草稿 (未綁定單一任務)"; titleEl.style.color = '#334155';
            titleEl.readOnly = true; noteArea.value = app.state.globalNotebook.free || "";
            if (nextStepBox) nextStepBox.style.display = 'none';
            if (nextStepInput) nextStepInput.value = '';
            app.entries.renderSandbox(null);
            this.renderCountdown();
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
            app.updateNextStepPreview(card.id);
        },

        wrapMarkdown(prefix, suffix) {
            const noteArea = document.getElementById('sb-activeNoteArea');
            if (document.activeElement !== noteArea) { const p = this.caretPos(noteArea); noteArea.selectionStart = noteArea.selectionEnd = p; }
            const start = noteArea.selectionStart; const end = noteArea.selectionEnd;
            const selectedText = noteArea.value.substring(start, end);
            noteArea.value = noteArea.value.substring(0, start) + prefix + selectedText + suffix + noteArea.value.substring(end);
            noteArea.focus(); noteArea.selectionStart = noteArea.selectionEnd = selectedText.length === 0 ? start + prefix.length : start + prefix.length + selectedText.length + suffix.length;
            this.saveActiveNote();
        },

        // 插入位置：游標所在那一行的下一行（游標在空行就直接用那行）。
        // 還沒點過筆記時，selectionStart 是 0，會插到最上面，所以改插到最後。
        insertBlock(text, { inline = false } = {}) {
            const ta = document.getElementById('sb-activeNoteArea');
            if (!ta) return;
            const v = ta.value;
            let pos = this.caretPos(ta);
            let at, ins;
            if (inline) { at = pos; ins = text; }
            else {
                const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
                const lineEndIdx = v.indexOf('\n', pos);
                const lineEnd = lineEndIdx === -1 ? v.length : lineEndIdx;
                if (!v.slice(lineStart, lineEnd).trim()) { at = lineStart; ins = text; ta.value = v.slice(0, lineStart) + v.slice(lineEnd); }
                else { at = lineEnd; ins = '\n' + text; }
            }
            const base = ta.value;
            ta.value = base.slice(0, at) + ins + base.slice(at);
            ta.focus();
            ta.selectionStart = ta.selectionEnd = at + ins.length;
            this._lastCaret = ta.selectionStart;
            this.saveActiveNote();
        },

        // 游標在筆記裡就用游標；剛點了下拉選單等（筆記失焦）就用離開時的位置；都沒有就放最後。
        caretPos(ta) {
            if (document.activeElement === ta) return ta.selectionStart ?? ta.value.length;
            if (this._lastCaret != null && this._lastCaret <= ta.value.length) return this._lastCaret;
            return ta.value.length;
        },

        insertPrefix(prefix) {
            const ta = document.getElementById('sb-activeNoteArea');
            if (ta && app.questions.markLines(ta, prefix)) return;
            this.insertBlock(prefix);
        },

        stampText() {
            const now = new Date();
            return `**[${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}]** `;
        },
        insertStamp() { this.insertBlock(this.stampText()); },

        insertTemplate(type) {
            const tpl = {
                bug: "### 🐛 異常現象\n\n### 🔬 測試假設\n\n### 🛠️ 下一步\n",
                dissect: "### 🎯 現況與目標\n\n### 🚧 卡關點\n\n### 💡 解法構思\n- [ ] ",
                review: "### ✅ 已完成\n\n### ❌ 待優化\n\n### 📌 備註\n"
            }[type];
            if (!tpl) return;
            const ta = document.getElementById('sb-activeNoteArea');
            const pos = this.caretPos(ta);
            this.insertBlock(tpl);
            // 游標停在第一個標題下面，直接開始寫
            const start = ta.value.indexOf(tpl.split('\n')[0], Math.max(0, pos - 1));
            if (start >= 0) { const p = ta.value.indexOf('\n', start) + 1; ta.selectionStart = ta.selectionEnd = p; }
        },

        addQuickLog() { this.insertStamp(); },

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
            try { this._renderTodoList(); } finally {
                try { this.renderDoneHint(); this.renderCountdown(); app.today?.renderSandbox(); } catch (err) { app.ui.reportError(err, '完成提示'); }
            }
        },

        // 待辦全部勾完（不管是點勾還是自己打 [x]）→ 問要不要把卡片標完成；反過來，已完成的卡又多了沒勾的待辦 → 問要不要重新打開
        doneState(card) {
            if (!card) return null;
            const subs = this.parseSubtasks(card.content);
            if (!subs.length) return null;
            const allDone = subs.every(st => st.completed);
            const completed = Number(card.status) === 2;
            if (allDone && !completed) return 'ask-complete';
            if (!allDone && completed) return 'ask-reopen';
            return null;
        },

        renderDoneHint() {
            const box = document.getElementById('sb-done-hint');
            if (!box) return;
            const card = this.activeCard();
            const st = this.doneState(card);
            const key = card ? `${card.id}|${st}|${card.content}` : '';
            if (!st || (this._doneDismissed || {})[card.id] === key) { box.innerHTML = ''; box.style.display = 'none'; return; }
            box.style.display = 'flex';
            box.innerHTML = st === 'ask-complete'
                ? `<span>🎉 待辦都勾完了，這張卡要標成完成嗎？</span>
                   <span class="sb-done-actions"><button type="button" class="primary" onclick="app.sandbox.completeActive(true)">✅ 完成並 🧹 整理</button><button type="button" onclick="app.sandbox.completeActive(false)">只標完成</button><button type="button" onclick="app.sandbox.dismissDoneHint()">還沒</button></span>`
                : `<span>這張卡已經標成完成，但還有沒勾的待辦。</span>
                   <span class="sb-done-actions"><button type="button" class="primary" onclick="app.sandbox.reopenActive()">重新打開</button><button type="button" onclick="app.sandbox.dismissDoneHint()">維持完成</button></span>`;
            box.className = `sb-done-hint ${st}`;
        },

        dismissDoneHint() {
            const card = this.activeCard();
            if (!card) return;
            this._doneDismissed = this._doneDismissed || {};
            this._doneDismissed[card.id] = `${card.id}|${this.doneState(card)}|${card.content}`;
            this.renderDoneHint();
        },

        async completeActive(tidy) {
            const card = this.activeCard();
            if (!card) return;
            app.worktime.markCompleted(card);
            app.saveToLocal();
            app.refreshCard(card.id, 'sandbox');
            app.ui.toast(`✅「${String(card.title || '').trim().split('\n')[0] || '未命名'}」標記完成`);
            if (tidy) await app.tidy.run(card.id, 'sandbox');
        },

        reopenActive() {
            const card = this.activeCard();
            if (!card) return;
            app.worktime.reopenCompleted(card, 1);
            app.saveToLocal();
            app.refreshCard(card.id, 'sandbox');
            app.ui.toast('已重新打開，回到進行中');
        },

        _renderTodoList() {
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
                    ${app.questions.open(c).length ? `<div class="sb-questions">${app.questions.open(c).map(q => `<div class="sb-question">❓ ${esc(q.text)}</div>`).join('')}</div>` : ''}
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
            if (note === '心流計時' && this.timerSub && sb.timerTaskId === this.timerSubCard) note = `心流計時｜${this.timerSub}`;
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

            if (!force && this.lastShownStatus === `${sb.timerStatus}|${sb.timerTaskId}|${sb.activeTaskId}|${sb.mode}|${this.timerSub || ''}`) {
                const targetBox = document.getElementById('sb-timerTarget');
                const acc = targetBox?.querySelector('.timer-acc');
                if (acc) acc.textContent = app.worktime.formatDuration(Math.floor(this.elapsedMs() / 1000));
                return;
            }
            this.lastShownStatus = `${sb.timerStatus}|${sb.timerTaskId}|${sb.activeTaskId}|${sb.mode}|${this.timerSub || ''}`;
            const esc = s => app.entries.escapeHtml(s);
            const gifBox = document.getElementById('sb-gifContainer');
            const statusText = document.getElementById('sb-statusText');
            const targetBox = document.getElementById('sb-timerTarget');
            const targetCard = sb.timerTaskId ? app.worktime.getCard(sb.timerTaskId) : null;
            const activeCard = sb.activeTaskId ? app.worktime.getCard(sb.activeTaskId) : null;
            const subCard = (sb.timerStatus !== 'IDLE' ? targetCard : activeCard);
            if (subCard && this.timerSubCard !== subCard.id) { this.timerSub = ''; this.timerSubCard = subCard.id; }
            const kids = subCard ? app.board.children(subCard).filter(c => !c.done && !c.childCard) : [];
            const subSel = kids.length ? `<div class="timer-sub">這次在做：<select onchange="app.sandbox.timerSub=this.value; app.sandbox.timerSubCard='${subCard.id}'; app.sandbox.lastShownStatus='';"><option value="">（整張卡）</option>${kids.map(c => `<option value="${esc(c.text)}" ${c.text === this.timerSub ? 'selected' : ''}>${esc(c.text)}</option>`).join('')}</select></div>` : '';
            if (targetBox) {
                if (targetCard && sb.timerStatus !== 'IDLE') {
                    targetBox.innerHTML = `記錄到：<strong>${esc(targetCard.title || '未命名')}</strong><br>本段已累積 <span class="timer-acc">${app.worktime.formatDuration(Math.floor(this.elapsedMs() / 1000))}</span>，停止時自動寫入卡片（跨午夜會自動分日）。${subSel}`;
                } else if (activeCard) {
                    targetBox.innerHTML = `準備記錄到：<strong>${esc(activeCard.title || '未命名')}</strong> <button type="button" class="worklog-action-btn" onclick="app.sandbox.switchLeftPanel('TODO')">換一張</button><br>按「啟動」後開始累積工時。也可以直接點左邊導覽列的卡片切換。${subSel}`;
                } else {
                    targetBox.innerText = '目前未綁定卡片。計時仍可使用，但不會寫入工時；先從任務清單選一張卡，或直接按卡片上的 ⏱️。';
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

        syncDeadlineInputs() { this.renderCountdown(); },
        updateCountdown() { this.renderCountdown(); },

        // 截止日：自動用卡片的「預計完成」。沒有的話可以直接在這裡設定。
        daysLeft(dateStr) {
            const d = app.worktime.parseLocalDate(dateStr);
            if (!d) return null;
            const today = new Date(); today.setHours(0, 0, 0, 0);
            return Math.round((d - today) / 86400000);
        },
        dayText(n) { return n > 0 ? `還剩 ${n} 天` : (n === 0 ? '今天到期' : `已過期 ${-n} 天`); },

        renderCountdown() {
            const box = document.getElementById('sb-deadline-box');
            if (!box) return;
            const esc = s => app.entries.escapeHtml(s);
            const W = app.worktime;
            const card = this.activeCard();
            let focus = '';
            if (card && Number(card.status) === 2) {
                const ae = String(card.actualEnd || '');
                focus = `<div class="dl-focus done"><b>${esc(String(card.title || '').trim().split('\n')[0] || '未命名卡片')}</b><br><span class="dl-big">✅ 已完成${ae ? `（${esc(ae.slice(5).replace('-', '/'))}）` : ''}</span></div>`;
            } else if (!card) {
                focus = `<div class="dl-focus none">還沒有選卡片。從「📋 任務清單」選一張，這裡會顯示它的截止日。</div>`;
            } else {
                const title = esc(String(card.title || '').trim().split('\n')[0] || '未命名卡片');
                const end = card.isMemo ? '' : W.plannedEnd(card);
                const n = end ? this.daysLeft(end) : null;
                if (n === null) {
                    focus = `<div class="dl-focus none"><b>${title}</b>：還沒排完成日
                        <div class="dl-set"><input type="date" value="" onchange="app.sandbox.setDeadline('${card.id}', this.value)" title="選了就設定為這張卡的預計完成日"><span class="pm-hint">選日期就設定好</span></div></div>`;
                } else {
                    const cls = n < 0 ? 'over' : (n === 0 ? 'today' : (n <= 2 ? 'soon' : 'ok'));
                    focus = `<div class="dl-focus ${cls}"><b>${title}</b><br><span class="dl-big">${esc(end.slice(5).replace('-', '/'))} 截止・${this.dayText(n)}</span>
                        <div class="dl-set"><input type="date" value="${esc(end)}" onchange="app.sandbox.setDeadline('${card.id}', this.value)" title="改預計完成日"><span class="pm-hint">可以直接改</span></div></div>`;
                }
            }
            const upcoming = W.allCards()
                .filter(({ card: c }) => Number(c.status) !== 2 && !c.isMemo && W.plannedEnd(c) && (!card || c.id !== card.id))
                .map(r => ({ ...r, n: this.daysLeft(W.plannedEnd(r.card)) }))
                .filter(r => r.n !== null && r.n <= 14 && r.n >= -30)
                .sort((a, b) => a.n - b.n)
                .slice(0, 3);
            const list = upcoming.length ? `<div class="dl-list"><div class="pm-hint" style="margin-bottom:2px;">接下來要到期（14 天內，含過期 30 天內）</div>${upcoming.map(r => `<button type="button" class="dl-row" onclick="app.taskNav.goToCard('${r.card.id}','${r.tabId}')" title="切換專注到這張卡"><span class="dl-title">${esc(String(r.card.title || '').trim().split('\n')[0] || '未命名')}</span><span class="dl-days ${r.n < 0 ? 'over' : ''}">${esc(W.plannedEnd(r.card).slice(5).replace('-', '/'))}・${this.dayText(r.n)}</span></button>`).join('')}</div>` : '';
            box.innerHTML = `<div class="dl-head">📅 截止日</div>${focus}${list}`;
        },

        setDeadline(cardId, value) {
            const card = app.worktime.getCard(cardId);
            if (!card || !app.worktime.parseLocalDate(value)) return;
            const W = app.worktime;
            card.isMemo = false;
            const start = W.plannedStart(card);
            const wasScheduled = !!W.plannedEnd(card);
            card.dateMode = 'range';
            card.dateEnd = value;
            card.dateStart = start && start <= value ? start : value;
            app.saveToLocal();
            this.renderCountdown();
            app.refreshCard(cardId, 'sandbox');
            app.ui.toast(`已設定「${String(card.title || '').trim() || '未命名'}」的完成日：${value}${wasScheduled ? '' : '（這張卡改為排程工項）'}`);
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
        const prevView = this.state.view;
        this.state.view = viewName;
        // 心流裡已經有「任務清單」，左側導覽列先收起來，離開心流再恢復。
        if (this.taskNav?.ui) {
            // 今日、清單也有自己的列表，同樣先收起導覽列
            const own = v => ['sandbox', 'today', 'lists'].includes(v);
            if (own(viewName) && !own(prevView)) {
                this.taskNav.ui.openBeforeSandbox = this.taskNav.ui.open;
                if (this.taskNav.ui.open) { this.taskNav.ui.open = false; this.taskNav.applyOpenState(); }
            } else if (!own(viewName) && own(prevView) && (this.taskNav.ui.openBeforeSandbox || (viewName === 'timeline' && !this.taskNav.ui.userClosed && this.taskNav.defaultOpen()))) {
                // 回到時間軸：導覽列（專案與卡片總覽）自動打開；自己關掉過就尊重
                this.taskNav.ui.open = true; this.taskNav.ui.openBeforeSandbox = false; this.taskNav.applyOpenState();
                this.taskNav.safe(() => this.taskNav.renderList());
            }
        }
        document.querySelectorAll('.view-container').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.toolbar .btn, #area-subnav .btn, .more-menu button').forEach(el => el.classList.remove('active'));
        const area = this.areaOf(viewName);
        const sub = document.getElementById('area-subnav');
        if (sub) sub.dataset.area = area;
        document.body.dataset.area = area;
        document.body.classList.toggle('has-subnav', area === 'schedule' || area === 'review');
        document.getElementById(`area-${area}`)?.classList.add('active');
        if (area === 'more') document.getElementById('btn-more')?.classList.add('active');
        if (area === 'schedule') this.prefs.scheduleView = viewName;
        if (area === 'review') this.prefs.reviewView = viewName;
        if (document.getElementById('view-' + viewName)) document.getElementById('view-' + viewName).classList.add('active');
        if (document.getElementById('btn-view-' + viewName)) document.getElementById('btn-view-' + viewName).classList.add('active');
        if (this.state.showProjectBar) document.getElementById('btn-project-bar')?.classList.add('active');
        if (this.taskNav?.ui?.open) document.getElementById('btn-task-nav')?.classList.add('active');
        this.rememberPrefs();

        if (viewName === 'sandbox') {
            this.renderTabs();
            this.sandbox.autoFocus();
            this.sandbox.refreshActiveNoteUI();
            this.sandbox.renderTodo();
            this.sandbox.updateDisplay(true);
        } else {
            this.renderAll();
        }
    },

    // 四個區塊：今日／卡片／時程／回顧；其他收在「更多」
    areaOf(view) {
        return ({ today: 'today', lists: 'cards', timeline: 'schedule', gantt: 'schedule', calendar: 'schedule', report: 'review', chronicle: 'review' })[view] || 'more';
    },
    goArea(area) {
        const v = area === 'cards' ? 'lists'
            : area === 'schedule' ? (['timeline', 'gantt', 'calendar'].includes(this.prefs.scheduleView) ? this.prefs.scheduleView : 'timeline')
            : area === 'review' ? 'report'
            : 'today';
        this.switchView(v);
    },
    toggleMore(e) {
        e?.stopPropagation();
        const m = document.getElementById('more-menu');
        if (!m) return;
        m.classList.toggle('open');
        // 工具列可以左右滑（overflow），選單改用固定定位才不會被切掉
        const r = document.getElementById('btn-more')?.getBoundingClientRect();
        if (r) { m.style.top = `${r.bottom + 6}px`; m.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 210))}px`; }
        if (m.classList.contains('open') && !this._moreBound) {
            this._moreBound = true;
            document.addEventListener('click', ev => { if (!ev.target.closest('.more-wrap')) this.closeMore(); });
        }
    },
    closeMore() { document.getElementById('more-menu')?.classList.remove('open'); },

    renderAll() {
        this.renderTabs(); if (this.state.showProjectBar) this.renderProjectBar();
        if (this.state.view === 'timeline') this.renderTimeline();
        else if (this.state.view === 'matrix') this.renderMatrix();
        else if (this.state.view === 'chronicle') this.renderChronicle();
        else if (this.state.view === 'gantt') this.renderGantt();
        else if (this.state.view === 'calendar') this.renderCalendar();
        else if (this.state.view === 'report') this.report.render();
        else if (this.state.view === 'lists') this.lists.render();
        else if (this.state.view === 'today') this.today.render();
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
        this._projectBarList = [...new Set([...cards.map(c => String(c.project || '').trim()), ...nodes.map(n => String(n.project || '').trim())].filter(Boolean))];
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
        if (this.state.filters.activeProject) cards = cards.filter(c => String(c.project || '').trim() === this.state.filters.activeProject);
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
                            <button class="icon-btn" onclick="app.gcal.open('${id}')" title="加到 Google 日曆">📆</button>
                            <button class="icon-btn" onclick="app.sandbox.focusTaskForTimer('${id}')" title="進入心流，專注在這張卡">🎯</button>
                            ${this.timerButtonHtml(card)}
                            <button class="icon-btn" onclick="app.board.open('${card.id}')" title="♟ 棋盤：把這張卡拆成子項目${app.board.children(card).length ? `（${app.board.children(card).length}）` : ''}">♟</button>
                            ${card.isMemo ? '' : `<button class="icon-btn" onclick="app.actions.toggleDateMode('${id}')" title="單日／區間">↔️</button>`}
                            <button class="icon-btn" onclick="app.actions.cycleColor('${id}')" title="切換標記顏色">🎨</button>
                        </div>
                    </div>
                    <div class="card-body">
                        <input type="text" class="input-title" ${fk('title')} value="${esc(card.title)}" placeholder="🏷️ 標題..." oninput="app.actions.editCardText('${id}', 'title', this.value)">
                        <textarea class="input-content" ${fk('content')} placeholder="📝 寫下卡片細節..." oninput="this.style.height='auto'; this.style.height=this.scrollHeight+'px'; app.actions.editCardText('${id}', 'content', this.value)">${esc(card.content)}</textarea>
                        <div class="note-tools">
                            <button type="button" onclick="app.questions.insertInCard('${id}','todo')" onmousedown="event.preventDefault()" title="新增一行待辦">＋ ✅ 待辦</button>
                            <button type="button" onclick="app.questions.insertInCard('${id}','question')" onmousedown="event.preventDefault()" title="新增一個待確認的問題">＋ ❓ 問題</button>
                            <button type="button" onclick="app.questions.insertInCard('${id}','answer')" onmousedown="event.preventDefault()" title="在游標所在的問題下面寫答案">＋ 💬 回答</button>
                            <button type="button" onclick="app.pasteSort.open('${id}')" onmousedown="event.preventDefault()" title="整段貼上，自動標出待辦／問題／回答再放進筆記">📥 貼上整理</button>
                        </div>
                        <div class="next-step-preview" id="next-preview-${id}" ${nextStep ? '' : 'style="display:none"'} onclick="app.actions.openPlanning('${id}')" title="點擊編輯下一步">➡ 下一步：<span>${esc(nextStep)}</span></div>
                        ${this.worktime.renderPlanningPanel(card, 'timeline')}
                        ${this.worktime.renderPanel(card, 'timeline')}
                        ${this.refs.render(card, 'timeline')}
                        ${this.entries.renderCardPanel(card, 'timeline')}
                    </div>
                    <div class="card-footer" style="display: flex; gap: 8px; align-items: center; justify-content: flex-end;">
                        <input type="text" class="input-project" ${fk('project')} value="${esc(card.project)}" placeholder="#專案名稱" oninput="app.actions.editCardText('${id}', 'project', this.value)" onchange="app.ui.renderWhenIdle()">
                        <select class="icon-btn" style="width: auto; padding: 0 5px; font-size: 0.85rem;" onchange="if(this.value) { app.actions.moveCard('${id}', this.value); this.value=''; }">
                            <option value="" disabled selected>🚀 轉移至...</option>${tabOptionsHtml}
                        </select>
                        <button class="icon-btn" onclick="app.mail.sendCard('${id}')" title="寄一份給自己（打開 Gmail，按傳送才會寄出）" style="width:34px; height:34px;">✉️</button>
                        <button class="icon-btn" onclick="app.tidy.run('${id}')" title="整理：把已勾選的待辦移到工作紀錄" style="width:34px; height:34px;">🧹</button>
                        <button class="icon-btn" onclick="app.coach.open({ template: 'stuck', cardId: '${id}' })" title="卡住了？請 AI 老師帶你想下一步" style="width:34px; height:34px;">🧑‍🏫</button>
                        <button class="icon-btn" onclick="app.actions.deleteCard('${id}')" style="color:#ef4444; border-color:#fca5a5; width:34px; height:34px;" title="刪除此卡片">🗑️</button>
                    </div>
                </div>
            </div>`;
    },

    cardBadgesHtml(card) {
        const esc = s => this.entries.escapeHtml(s);
        const openQ = this.questions.open(card);
        const qBadge = openQ.length ? `<span class="question-badge" title="${esc(openQ.map(q => '❓ ' + q.text).join('\n'))}">❓ ${openQ.length}</span>` : '';
        return (this.today ? this.today.badgeHtml(card) : '') + qBadge + this.waitingBadgeHtml(card);
    },

    waitingBadgeHtml(card) {
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
                this.sandbox.renderCountdown();
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

    renderMatrix() { app.board.renderFull(); },

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
            const out = { wk, nx, done: [], doing: [], next: [], waiting: [], overdue: [], questions: [], minutes: 0 };
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
                if (status !== 2) app.questions.open(card).forEach(q => out.questions.push({ ...item, q }));
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
            if (kind === 'question') return `${p}：❓ ${arguments[1].q?.text || ''}`;
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
                data.questions.length ? sec('待確認問題', 'question', data.questions, '') : '',
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
                    ${block('❓', '待確認問題', 'question', data.questions, '沒有待確認的問題。在卡片筆記按「＋ ❓ 問題」記下來，有答案時按「＋ 💬 回答」。')}
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
                        <summary>給 AI 的設定：關於我、公司專案清單、專案名稱對照</summary>
                        ${app.aiAboutField()}
                        <div class="data-note"><b>公司專案清單</b>（一行一個，照公司工時表上的全名）。AI 填工時表的「專案」欄只會從這裡選。公司接了新標案、或舊案結束，就在這裡改。</div>
                        <textarea class="task-meta-textarea" rows="5" oninput="app.journal.saveCompanyProjects(this.value)">${esc(companyProjects().join('\n'))}</textarea>
                        <div style="display:flex; justify-content:flex-end; margin:-4px 0 8px;"><button type="button" class="ps-mini" onclick="app.journal.resetCompanyProjects()" title="回到內建的四個專案">恢復預設</button></div>
                        <div class="data-note"><b>專案名稱對照</b>（選填）。AI 會依工作區和專案名稱自動判斷；只有判斷容易錯的，才需要寫：白板上的專案名稱 = 公司案名。</div>
                        <textarea class="task-meta-textarea" rows="4" placeholder="化學署官網會議 = 化學物質管理署「114-116年度中英文全球資訊網與業務網站整合、維運暨功能擴增案」&#10;環境部 = 環境部「115-116年度內外網系統維運暨功能擴增案」&#10;日常 = 公司/部門事務" oninput="app.journal.saveProjectMap(this.value)">${esc(app.settings.get('companyProjectMap') || '')}</textarea>
                    </details>
                    <div class="data-note" style="padding:0 12px 10px;">時間欄：計時的紀錄會自動有起訖時間；補登時可以選填「開始」時間。只有日期的補登，時間欄會留白。</div>
                </section>`;
        },

        copy() { app.worktime.copyText(this.text(), '已複製工作日誌'); },

        saveProjectMap(v) { app.settings.set('companyProjectMap', v); },
        saveCompanyProjects(v) {
            app.settings.set('companyProjects', String(v || '').split('\n').map(x => x.trim()).filter(Boolean));
        },
        async resetCompanyProjects() {
            if (!await app.ui.confirm('恢復預設的公司專案清單？', `<p>會回到內建的四個：</p><p>${COMPANY_PROJECTS.map(c => app.entries.escapeHtml(c)).join('<br>')}</p>`, '恢復預設')) return;
            app.settings.set('companyProjects', []);
            this.filters.showAiSettings = true;
            app.report.render();
        },

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
            const map = String(app.settings.get('companyProjectMap') || '').trim();
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
                companyProjects().map(c => `   - ${c}`).join('\n'),
                '   判斷順序：先看【專案名稱對照】；沒有的話，依「工作區」與專案名稱判斷（例如工作區「環境部」→ 環境部的案子、「化學署」→ 化學物質管理署的案子、「氣候」→ 氣候變遷署的案子）；公司內部會議、部門事務、行政、訓練等歸到「公司/部門事務」。真的判斷不出來的，在表格後面列出來問我。',
                '5. 標成「筆記，不算工時」的只用來幫你理解當天在做什麼，不要算進工時。',
                '6. 如果我有自己選類別，以我選的為主；你覺得明顯不對時，在表格後面另外提醒我。',
                '7. 表格後面用 1～3 行列出：每天工時合計，以及你不確定、需要我確認的地方。',
                '',
                '【專案名稱對照】（我自己補充的，優先使用）',
                [...app.projectReg.mappingLines(), map].filter(Boolean).join('\n') || '（沒有額外對照，依上面規則判斷）',
                '',
                `【工作紀錄】${data.r.s} ～ ${data.r.e}`,
                lines.join('\n') || '（這段期間沒有紀錄）'
            ].join('\n');
        },

        copyForAI() { app.worktime.copyText(app.aiText(this.aiPrompt()), '已複製，貼給 Claude 就會整理成公司工時表'); },

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
            '我正在學專案管理，特別是「以交付物為主的拆解」和「跟別人協作、回報進度」。我平常會自己做，但不確定拆得對不對、問得好不好。',
            '請用帶新人的方式陪我練，「先示範、再解釋、最後考我」：',
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

【請用主管審查計畫的角度挑毛病】
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
${app.questions.open(card).length ? `這張卡目前還沒有答案的問題（請挑出最該問這個人的，或合併成一則訊息）：\n${app.questions.open(card).map(q => `- ${q.text}`).join('\n')}` : ''}

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
            const text = app.aiText(document.getElementById('coach-prompt')?.value || this.buildPrompt());
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
    // 📎 參考資料（每張卡的連結清單）＋ 🧹 整理（已勾待辦移到工作紀錄）
    // ==========================================
    refs: {
        editing: {},

        list(card) { return Array.isArray(card?.refs) ? card.refs : []; },
        isCardRef(r) { return r?.type === 'card' && r.cardId; },
        // 連到的卡（即時讀名稱；卡被刪了回傳 null）
        target(r) {
            const row = app.worktime.allCards().find(x => x.card.id === r.cardId);
            return row || null;
        },
        cardName(c) { return String(c?.title || '').trim().split('\n')[0] || '未命名'; },
        // 被誰連到：即時算出來，不另外存
        backlinks(card) {
            if (!card) return [];
            return app.worktime.allCards().filter(({ card: c }) => c.id !== card.id && this.list(c).some(r => this.isCardRef(r) && r.cardId === card.id));
        },
        cardChip(r) {
            const esc = s => app.entries.escapeHtml(s);
            const t = this.target(r);
            if (!t) return `<span class="ref-chip ref-card gone" title="這張卡已經刪除或合併">🗂 ${esc(r.title || '卡片')}（已刪除）</span>`;
            return `<button type="button" class="ref-chip ref-card" onclick="event.stopPropagation(); app.taskNav.goToCard('${t.card.id}','${t.tabId}')" title="打開這張卡（${esc(t.tabName)}）">🗂 ${esc(this.cardName(t.card))}</button>`;
        },
        backlinkHtml(card) {
            const esc = s => app.entries.escapeHtml(s);
            const bl = this.backlinks(card);
            if (!bl.length) return '';
            return `<div class="ref-backlinks"><span class="ref-backlinks-label">被這些卡參考：</span>${bl.map(({ card: c, tabId, tabName }) => `<button type="button" class="ref-chip ref-card back" onclick="event.stopPropagation(); app.taskNav.goToCard('${c.id}','${tabId}')" title="${esc(tabName)}">↩ ${esc(this.cardName(c))}</button>`).join('')}</div>`;
        },

        pickCard(cardId, source = 'timeline') {
            const card = app.worktime.getCard(cardId);
            if (!card) return;
            this._pick = { cardId, source, q: '' };
            app.ui.dialog({
                title: '🗂 連到另一張卡',
                wide: true,
                html: `<input id="refpick-q" class="ps-input" style="min-height:0;height:auto;" placeholder="搜尋卡片名稱或專案…" oninput="app.refs._pick.q=this.value; app.refs.renderPick()">
                    <div id="refpick-list" class="refpick-list"></div>
                    <p class="pm-hint">連過去之後，那張卡的參考資料會自動顯示「被這些卡參考」。</p>`,
                buttons: [{ label: '取消', value: null }]
            });
            this.renderPick();
            setTimeout(() => document.getElementById('refpick-q')?.focus(), 30);
        },
        renderPick() {
            const el = document.getElementById('refpick-list');
            const P = this._pick;
            if (!el || !P) return;
            const esc = s => app.entries.escapeHtml(s);
            const card = app.worktime.getCard(P.cardId);
            const linked = new Set(this.list(card).filter(r => this.isCardRef(r)).map(r => r.cardId));
            const q = P.q.trim().toLowerCase();
            const proj = String(card?.project || '').trim();
            const ts = c => Number(String(c.id).match(/(\d{10,})/)?.[1] || 0);
            const rows = app.worktime.allCards()
                .filter(({ card: c }) => c.id !== P.cardId && !linked.has(c.id))
                .filter(({ card: c, tabName }) => !q || [c.title, c.project, tabName].some(t => String(t || '').toLowerCase().includes(q)))
                .sort((a, b) => ((String(b.card.project || '').trim() === proj) - (String(a.card.project || '').trim() === proj)) || (Number(a.card.status) === 2) - (Number(b.card.status) === 2) || ts(b.card) - ts(a.card))
                .slice(0, 40);
            el.innerHTML = rows.length ? rows.map(({ card: c, tabName }) => `<button type="button" class="refpick-item" onclick="app.refs.linkCard('${P.cardId}','${c.id}','${P.source}')">
                    <span class="refpick-title">${esc(this.cardName(c))}</span>
                    <span class="ls-meta">${c.project ? '#' + esc(c.project) + ' · ' : ''}${esc(tabName)}${Number(c.status) === 2 ? ' · 已完成' : ''}</span>
                </button>`).join('') : '<div class="data-empty">找不到符合的卡片。</div>';
        },
        linkCard(cardId, targetId, source = 'timeline') {
            const card = app.worktime.getCard(cardId);
            const target = app.worktime.getCard(targetId);
            if (!card || !target) return;
            if (!Array.isArray(card.refs)) card.refs = [];
            if (!card.refs.some(r => this.isCardRef(r) && r.cardId === targetId)) {
                card.refs.push({ id: app.makeId('ref'), type: 'card', cardId: targetId, title: this.cardName(target), url: '', createdAt: new Date().toISOString() });
            }
            app.saveToLocal();
            document.querySelector('.app-dialog-overlay .app-dialog-btn')?.click();
            app.setPanelOpen(source, cardId, 'refs', true);
            this.refresh(cardId, source);
            app.refreshCard(targetId); // 對方的「被參考」
            app.ui.toast(`已連到「${this.cardName(target)}」`);
        },

        isUrl(s) { return /^(https?:\/\/|\\\\|file:\/\/|[a-zA-Z]:\\)/.test(String(s || '').trim()); },

        normalizeUrl(u) {
            u = String(u || '').trim();
            if (/^www\./i.test(u)) u = 'https://' + u;
            return u;
        },

        // 網址顯示用的短名稱
        shortLabel(url) {
            const u = String(url || '');
            const g = u.match(/docs\.google\.com\/(document|spreadsheets|presentation|forms)/);
            if (g) return ({ document: 'Google 文件', spreadsheets: 'Google 試算表', presentation: 'Google 簡報', forms: 'Google 表單' })[g[1]];
            if (/drive\.google\.com/.test(u)) return 'Google 雲端硬碟';
            if (/mail\.google\.com/.test(u)) return 'Gmail 信件';
            if (/^\\\\/.test(u)) return '網路磁碟路徑';
            try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u.slice(0, 40); }
        },

        render(card, source = 'timeline') {
            const esc = s => app.entries.escapeHtml(s);
            const id = card.id;
            const refs = this.list(card);
            const open = app.panelOpen(source, id, 'refs');
            const known = new Set(refs.filter(r => !this.isCardRef(r)).map(r => r.url));
            const chip = r => this.isCardRef(r) ? this.cardChip(r) : `<a class="ref-chip" href="${esc(this.href(r.url))}" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="${esc(r.url)}">${esc(r.title || this.shortLabel(r.url))}</a>`;
            const backN = this.backlinks(card).length;
            const urlsInContent = this.findInContent(card).filter(f => !known.has(this.normalizeUrl(f.url))).length;
            if (!open) {
                return `<div class="refs-panel refs-collapsed" id="refs-panel-${source}-${id}">
                    <button type="button" class="worktime-collapsed-btn" onclick="app.refs.toggle('${id}','${source}')">
                        <span style="font-weight:bold;color:#475569;">📎 參考資料</span>
                        <span class="worklog-count">${refs.length}</span>
                        <span class="refs-chips">${refs.slice(0, 4).map(chip).join('')}${refs.length > 4 ? `<span class="ref-more">+${refs.length - 4}</span>` : ''}${backN ? `<span class="ref-more" title="被其他卡參考">↩ ${backN}</span>` : ''}</span>
                        ${urlsInContent ? `<span class="ref-hint">筆記裡有 ${urlsInContent} 個連結可以搬進來</span>` : ''}
                        <span class="worktime-open">展開 ▾</span>
                    </button>
                </div>`;
            }
            const editingId = this.editing[`${source}:${id}`];
            const rows = refs.length ? refs.map(r => this.isCardRef(r) ? (() => {
                const t = this.target(r);
                return `<div class="ref-row">
                    ${this.cardChip(r)}
                    <span class="ref-url">${t ? `卡片 · ${esc(t.tabName)}${Number(t.card.status) === 2 ? ' · 已完成' : ''}` : '已刪除'}</span>
                    ${t ? `<button class="worktime-edit" title="進心流專注這張卡" onclick="app.sandbox.focusTaskForTimer('${t.card.id}')">🎯</button>` : ''}
                    <button class="worktime-delete" title="移除這個連結（不會刪掉那張卡）" onclick="app.refs.remove('${id}','${r.id}','${source}')">×</button>
                </div>`;
            })() : r.id === editingId ? `
                <div class="ref-row ref-edit">
                    <input id="refedit-title-${source}-${id}" class="worktime-input" value="${esc(r.title || '')}" placeholder="名稱">
                    <input id="refedit-url-${source}-${id}" class="worktime-input" value="${esc(r.url || '')}" placeholder="網址或路徑" onkeydown="if(event.key==='Enter') app.refs.saveEdit('${id}','${r.id}','${source}')">
                    <button class="worklog-action-btn" onclick="app.refs.cancelEdit('${id}','${source}')">取消</button>
                    <button class="worklog-action-btn" style="color:#4338ca;border-color:#c7d2fe;" onclick="app.refs.saveEdit('${id}','${r.id}','${source}')">儲存</button>
                </div>` : `
                <div class="ref-row">
                    <a class="ref-link" href="${esc(this.href(r.url))}" target="_blank" rel="noopener" title="${esc(r.url)}">🔗 ${esc(r.title || this.shortLabel(r.url))}</a>
                    <span class="ref-url">${esc(this.shortLabel(r.url))}</span>
                    <button class="worktime-edit" title="複製連結" onclick="app.worktime.copyText(${esc(JSON.stringify(r.url))}, '已複製連結')">📋</button>
                    <button class="worktime-edit" title="修改" onclick="app.refs.startEdit('${id}','${r.id}','${source}')">✏️</button>
                    <button class="worktime-delete" title="刪除" onclick="app.refs.remove('${id}','${r.id}','${source}')">×</button>
                </div>`).join('') : '<div class="worktime-empty">還沒有參考資料。把常用的文件、試算表、信件連結放這裡，平常只會顯示名稱。</div>';
            return `<div class="refs-panel" id="refs-panel-${source}-${id}">
                <div class="worktime-header">
                    <span style="font-weight:bold;color:#475569;">📎 參考資料 <span class="worklog-count">${refs.length}</span></span>
                    <span style="display:flex;gap:6px;align-items:center;">
                        ${urlsInContent ? `<button class="worklog-action-btn" onclick="app.refs.extractFromContent('${id}','${source}')" title="把筆記裡的網址搬進參考資料">從筆記抓連結（${urlsInContent}）</button>` : ''}
                        <button class="worklog-action-btn" onclick="app.refs.toggle('${id}','${source}')">收合</button>
                    </span>
                </div>
                <div class="ref-form">
                    <input id="ref-title-${source}-${id}" class="worktime-input" placeholder="名稱，例如：管控表 115 上半年">
                    <input id="ref-url-${source}-${id}" class="worktime-input" placeholder="貼上網址或網路磁碟路徑" onkeydown="if(event.key==='Enter') app.refs.add('${id}','${source}')">
                    <button class="worklog-add-btn" onclick="app.refs.add('${id}','${source}')">＋ 加入</button>
                    <button class="worklog-action-btn" onclick="app.refs.pickCard('${id}','${source}')" title="參考另一張卡">🗂 連到卡片</button>
                </div>
                <div class="ref-list">${rows}</div>
                ${this.backlinkHtml(card)}
            </div>`;
        },

        href(url) {
            const u = String(url || '').trim();
            if (/^\\\\/.test(u)) return 'file:' + u.replace(/\\/g, '/');
            return this.normalizeUrl(u);
        },

        toggle(cardId, source = 'timeline') {
            app.setPanelOpen(source, cardId, 'refs', !app.panelOpen(source, cardId, 'refs'));
            this.refresh(cardId, source);
        },

        refresh(cardId, source = 'timeline') {
            app.ui.defer(() => {
                const card = app.worktime.getCard(cardId);
                if (!card) return;
                const el = document.getElementById(`refs-panel-${source}-${cardId}`);
                if (el) el.outerHTML = this.render(card, source);
            });
        },

        add(cardId, source = 'timeline') {
            const card = app.worktime.getCard(cardId);
            if (!card) return;
            const titleEl = document.getElementById(`ref-title-${source}-${cardId}`);
            const urlEl = document.getElementById(`ref-url-${source}-${cardId}`);
            let title = (titleEl?.value || '').trim();
            let url = (urlEl?.value || '').trim();
            if (!url && this.isUrl(title)) { url = title; title = ''; }
            if (!url) { app.ui.toast('請貼上網址或路徑', 'warn'); urlEl?.focus(); return; }
            if (!Array.isArray(card.refs)) card.refs = [];
            card.refs.push({ id: app.makeId('ref'), title: title || this.shortLabel(url), url: this.normalizeUrl(url), createdAt: new Date().toISOString() });
            app.saveToLocal();
            this.refresh(cardId, source);
            setTimeout(() => document.getElementById(`ref-title-${source}-${cardId}`)?.focus(), 60);
        },

        startEdit(cardId, refId, source) { this.editing[`${source}:${cardId}`] = refId; this.refresh(cardId, source); },
        cancelEdit(cardId, source) { delete this.editing[`${source}:${cardId}`]; this.refresh(cardId, source); },
        saveEdit(cardId, refId, source) {
            const card = app.worktime.getCard(cardId);
            const r = this.list(card).find(x => x.id === refId);
            if (!r) return;
            const url = (document.getElementById(`refedit-url-${source}-${cardId}`)?.value || '').trim();
            const title = (document.getElementById(`refedit-title-${source}-${cardId}`)?.value || '').trim();
            if (!url) { app.ui.toast('網址不能是空的；不要的話按 × 刪除', 'warn'); return; }
            r.url = this.normalizeUrl(url);
            r.title = title || this.shortLabel(url);
            delete this.editing[`${source}:${cardId}`];
            app.saveToLocal();
            this.refresh(cardId, source);
        },
        async remove(cardId, refId, source) {
            const card = app.worktime.getCard(cardId);
            const r = this.list(card).find(x => x.id === refId);
            if (!r) return;
            const isCard = this.isCardRef(r);
            if (!await app.ui.confirm(isCard ? '移除卡片連結' : '刪除參考資料', isCard ? `<p>移除連到「${app.entries.escapeHtml(this.target(r) ? this.cardName(this.target(r).card) : r.title)}」的連結？那張卡本身不會被刪。</p>` : `<p>刪除「${app.entries.escapeHtml(r.title || r.url)}」？</p>`, isCard ? '移除' : '刪除', true)) return;
            card.refs = card.refs.filter(x => x.id !== refId);
            app.saveToLocal();
            this.refresh(cardId, source);
            if (isCard) app.refreshCard(r.cardId);
        },

        // 找出筆記裡的連結：網址那一行，名稱取前一行（像「公司網站審查表」）或同一行網址前的文字
        findInContent(card) {
            const lines = String(card?.content || '').split('\n');
            const urlRe = /(https?:\/\/[^\s)）\]」，、。；]+|\\\\[^\s，、。；)）]+)/;
            const isHeading = t => t && !urlRe.test(t) && t.length <= 30 && !/^- \[[ xX?aA]\]/.test(t) && t !== '---' && !/^[*※]/.test(t) && !/[:：].{6,}/.test(t);
            const clean = t => t.replace(/^[-*•]\s*/, '').replace(/[:：]$/, '').replace(/[（(][^）)]*[）)]\s*$/, '').trim();
            const found = [];
            let group = null; // 連續的網址沿用同一個標題
            lines.forEach((line, i) => {
                const m = line.match(urlRe);
                if (!m) { if (line.trim()) group = null; return; }
                const before = line.slice(0, m.index).replace(/^[\s\-*•\d.、)）]+/, '').replace(/[:：\s]+$/, '').trim();
                const after = line.slice(m.index + m[0].length).trim();
                let title = before, titleLine = -1, parentLine = -1;
                if (!title && i > 0) {
                    const prev = lines[i - 1].trim();
                    if (isHeading(prev)) {
                        title = clean(prev);
                        titleLine = i - 1;
                        // 「-115上半年」這種子項目，加上再上一層的標題
                        const prev2 = i > 1 ? lines[i - 2].trim() : '';
                        if (/^[-•]/.test(prev) && isHeading(prev2) && !/^[-•]/.test(prev2)) { title = `${clean(prev2)} ${title}`; parentLine = i - 2; }
                        else if (/^[-•]/.test(prev) && i > 2 && found.length && found[found.length - 1].parent) { title = `${found[found.length - 1].parent} ${title}`; parentLine = found[found.length - 1].parentLine; }
                        group = { name: title, n: 1 };
                    } else if (group && urlRe.test(prev)) {
                        group.n += 1;
                        title = `${group.name} ${group.n}`;
                    }
                }
                const parentHeading = (() => {
                    const p1 = i > 1 ? lines[i - 2].trim() : '';
                    return titleLine >= 0 && /^[-•]/.test(lines[i - 1].trim()) && isHeading(p1) && !/^[-•]/.test(p1) ? clean(p1) : (found.length ? found[found.length - 1].parent : null);
                })();
                found.push({ line: i, titleLine, parentLine, url: m[0], title: title || '', rest: after, parent: parentHeading });
            });
            return found;
        },

        async extractFromContent(cardId, source = 'timeline') {
            const card = app.worktime.getCard(cardId);
            if (!card) return;
            const known0 = new Set(this.list(card).filter(r => !this.isCardRef(r)).map(r => r.url));
            const found = this.findInContent(card).filter(f => !known0.has(this.normalizeUrl(f.url)));
            if (!found.length) { app.ui.toast('筆記裡沒有新的連結'); return; }
            const esc = s => app.entries.escapeHtml(s);
            const ok = await app.ui.dialog({
                title: `從筆記搬 ${found.length} 個連結到參考資料`,
                wide: true,
                html: `<p>會把下面的連結加進「📎 參考資料」，並從筆記裡刪掉這些網址行（名稱那一行也會一起移走）。其他文字不動。</p>
                    <div class="diff-block">${found.map(f => `<div style="padding:3px 0;font-size:.84rem;"><b>${esc(f.title || this.shortLabel(f.url))}</b><br><span style="color:#64748b;word-break:break-all;">${esc(f.url)}</span></div>`).join('')}</div>
                    <p class="data-note">名稱之後可以在參考資料裡用 ✏️ 修改。</p>`,
                buttons: [{ label: '取消', value: false }, { label: '搬過去', value: true, primary: true }]
            });
            if (!ok) return;
            if (!Array.isArray(card.refs)) card.refs = [];
            const now = new Date().toISOString();
            const have = new Set(card.refs.filter(r => !this.isCardRef(r)).map(r => r.url));
            const remove = new Set();
            found.forEach(f => {
                const url = this.normalizeUrl(f.url);
                if (!have.has(url)) { card.refs.push({ id: app.makeId('ref'), title: f.title || this.shortLabel(url), url, createdAt: now }); have.add(url); }
                if (f.rest) return; // 網址後面還有文字的行，只搬連結、保留那一行
                remove.add(f.line);
                if (f.titleLine >= 0) remove.add(f.titleLine);
            });
            // 整組子連結都搬走時，上一層的小標題（例如「我的管控表」）也一起移走
            const parents = new Map();
            found.forEach(f => { if (f.parentLine >= 0) { const g = parents.get(f.parentLine) || { all: true }; g.all = g.all && remove.has(f.line); parents.set(f.parentLine, g); } });
            parents.forEach((g, ln) => { if (g.all) remove.add(ln); });
            const lines = String(card.content || '').split('\n').filter((_, i) => !remove.has(i));
            card.content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
            app.saveToLocal();
            app.setPanelOpen(source, cardId, 'refs', true);
            app.refreshCard(cardId, source);
            if (source === 'sandbox' || app.state.view === 'sandbox') app.sandbox.refreshActiveNoteUI();
            app.ui.toast(`已搬 ${found.length} 個連結到參考資料`);
        }
    },

    // ==========================================
    // ❓ 問題清單：筆記裡「- [?] 問題」與其下的「- [A] 回答」（舊的 ❓/💬 寫法也認得，載入時自動轉換）
    // ==========================================
    questions: {
        Q: '- [?]',
        A: '- [A]',
        LEGACY_Q: '❓',
        LEGACY_A: '💬',

        // 回傳 [{ line, text, answers: [..], answerLines: [..] }]
        parse(content) {
            const lines = String(content || '').split('\n');
            const out = [];
            let cur = null;
            const qRe = /^[-*]\s+\[\?\]\s?(.*)$/, aRe = /^[-*]\s+\[[aA]\]\s?(.*)$/;
            lines.forEach((raw, i) => {
                const t = raw.trim();
                const qm = t.match(qRe) || (t.startsWith(this.LEGACY_Q) ? [t, t.slice(this.LEGACY_Q.length)] : null);
                const am = t.match(aRe) || (t.startsWith(this.LEGACY_A) ? [t, t.slice(this.LEGACY_A.length)] : null);
                if (qm) {
                    cur = { line: i, text: qm[1].trim(), answers: [], answerLines: [] };
                    out.push(cur);
                } else if (cur && am) {
                    cur.answers.push(am[1].trim());
                    cur.answerLines.push(i);
                } else if (t) {
                    cur = null;
                }
            });
            return out.filter(q => q.text);
        },
        open(card) { return this.parse(card?.content).filter(q => !q.answers.some(Boolean)); },
        answered(card) { return this.parse(card?.content).filter(q => q.answers.some(Boolean)); },

        // 在 textarea 插入：問題＝新的一行「- [?] 」；回答＝目前這行下面插入「- [A] 」（不縮排）
        insert(textarea, kind) {
            if (!textarea) return;
            if (kind === 'todo') return this.insertLine(textarea, '- [ ] ');
            if (kind === 'question') return this.insertLine(textarea, `${this.Q} `);
            if (kind === 'answer') return this.insertLine(textarea, `${this.A} `);
            return this.insertLine(textarea, `${this.Q} `);
        },

        // 選取了好幾行：每一行都加上（或換成）這個標記
        markLines(textarea, prefix) {
            const v = textarea.value;
            const a = textarea.selectionStart, b = textarea.selectionEnd;
            if (document.activeElement !== textarea || a === b || !v.slice(a, b).includes('\n')) return false;
            const start = v.lastIndexOf('\n', a - 1) + 1;
            const endIdx = v.indexOf('\n', b - (v[b - 1] === '\n' ? 1 : 0));
            const end = endIdx === -1 ? v.length : endIdx;
            const marker = /^(\s*)(?:[-*]\s+\[[ xX?aA]\]\s?|❓\uFE0F?\s*|💬\s*|[-*•・]\s+)?/;
            const block = v.slice(start, end).split('\n').map(l => l.trim() ? l.replace(marker, (m, ind) => ind) .replace(/^(\s*)/, `$1${prefix}`) : l).join('\n');
            textarea.value = v.slice(0, start) + block + v.slice(end);
            textarea.focus();
            textarea.selectionStart = start; textarea.selectionEnd = start + block.length;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        },

        insertLine(textarea, prefix) {
            if (this.markLines(textarea, prefix)) return;
            const v = textarea.value;
            const pos = textarea.id === 'sb-activeNoteArea' ? app.sandbox.caretPos(textarea) : (textarea.selectionStart ?? v.length);
            const lineStart = v.lastIndexOf('\n', pos - 1) + 1;
            const lineEndIdx = v.indexOf('\n', pos);
            const lineText = v.slice(lineStart, lineEndIdx === -1 ? v.length : lineEndIdx);
            let insertAt, text;
            if (!lineText.trim()) { insertAt = lineStart; text = prefix; }
            else { insertAt = lineEndIdx === -1 ? v.length : lineEndIdx; text = `\n${prefix}`; }
            textarea.value = v.slice(0, insertAt) + text + v.slice(insertAt);
            textarea.focus();
            textarea.selectionStart = textarea.selectionEnd = insertAt + text.length;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        },

        insertInCard(cardId, kind) {
            const ta = document.querySelector(`[data-fk="${CSS.escape(`timeline:${cardId}:content`)}"]`);
            this.insert(ta, kind);
        },

        // 所有卡片裡還沒答案的問題
        allOpen(filterFn = null) {
            const out = [];
            app.worktime.allCards().forEach(row => {
                if (filterFn && !filterFn(row)) return;
                if (Number(row.card.status) === 2) return;
                this.open(row.card).forEach(q => out.push({ ...row, q }));
            });
            return out;
        }
    },

    tidy: {
        // 已勾選的待辦（含它底下縮排的子行）
        findDone(content) {
            const lines = String(content || '').split('\n');
            const done = [];
            const remove = new Set();
            for (let i = 0; i < lines.length; i++) {
                const m = lines[i].match(/^(\s*)[-*]\s+\[[xX]\]\s+(.*)$/);
                if (!m) continue;
                const indent = m[1].length;
                const block = [m[2].trim()];
                remove.add(i);
                let j = i + 1;
                while (j < lines.length && lines[j].trim() && (lines[j].match(/^(\s*)/)[1].length > indent)) {
                    block.push(lines[j].trim().replace(/^[-*]\s+(\[[ xX]\]\s+)?/, ''));
                    remove.add(j);
                    j++;
                }
                done.push(block);
                i = j - 1;
            }
            return { done, remaining: lines.filter((_, i) => !remove.has(i)).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') };
        },

        async run(cardId, source = 'timeline') {
            const card = app.worktime.getCard(cardId);
            if (!card) return;
            if (source === 'sandbox') app.sandbox.saveActiveNote();
            const { done, remaining: afterTodos } = this.findDone(card.content);
            // 已有答案的問題（❓＋💬）一起移走
            const answered = app.questions.parse(afterTodos).filter(q => q.answers.some(Boolean));
            const drop = new Set(answered.flatMap(q => [q.line, ...q.answerLines]));
            const remaining = afterTodos.split('\n').filter((_, i) => !drop.has(i)).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
            if (!done.length && !answered.length) { app.ui.toast('沒有已勾選的待辦或已回答的問題需要整理'); return; }
            const esc = s => app.entries.escapeHtml(s);
            const ok = await app.ui.dialog({
                title: `整理：${done.length ? `${done.length} 項已完成` : ''}${done.length && answered.length ? '、' : ''}${answered.length ? `${answered.length} 個問題已回答` : ''}`,
                html: `<p>這些會移到今天的一筆工作紀錄，並從卡片筆記裡移除：</p>
                    <div class="diff-block">${done.map(b => `<div style="padding:2px 0;font-size:.86rem;">✅ ${esc(b[0])}${b.length > 1 ? `<br><small style="color:#64748b;">${b.slice(1).map(esc).join('<br>')}</small>` : ''}</div>`).join('')}${answered.map(q => `<div style="padding:2px 0;font-size:.86rem;">❓ ${esc(q.text)}<br><small style="color:#64748b;">💬 ${q.answers.filter(Boolean).map(esc).join('<br>💬 ')}</small></div>`).join('')}</div>
                    <p class="data-note">沒勾的待辦、還沒回答的問題、連結和其他文字都不會動。</p>`,
                buttons: [{ label: '取消', value: false }, { label: '整理', value: true, primary: true }]
            });
            if (!ok) return;
            const d = new Date();
            const now = d.toISOString();
            if (!Array.isArray(card.entries)) card.entries = [];
            card.entries.push({
                id: app.makeId('entry'),
                title: `完成：${d.getMonth() + 1}/${d.getDate()} 整理（${[done.length ? `${done.length} 項` : '', answered.length ? `${answered.length} 題` : ''].filter(Boolean).join('、')}）`,
                content: [
                    ...done.map(b => `✅ ${b[0]}${b.length > 1 ? '\n' + b.slice(1).map(x => `   ${x}`).join('\n') : ''}`),
                    ...answered.map(q => `- [?] ${q.text}\n${q.answers.filter(Boolean).map(a => `- [A] ${a}`).join('\n')}`)
                ].join('\n'),
                createdAt: now, updatedAt: now
            });
            card.content = remaining;
            app.saveToLocal();
            app.refreshCard(cardId, source);
            if (app.state.view === 'sandbox' && app.state.sandbox.activeTaskId === cardId) app.sandbox.refreshActiveNoteUI();
            app.ui.toast(`已移到工作紀錄：${[done.length ? `${done.length} 項待辦` : '', answered.length ? `${answered.length} 個問題` : ''].filter(Boolean).join('、')}`);
        }
    },

    // ==========================================
    // ✉️ 寄給自己：把卡片整理成一封信，打開 Gmail 撰寫視窗（按傳送才會寄出）
    // ==========================================
    mail: {
        GMAIL_URL_LIMIT: 7000,

        cardText(card) {
            const W = app.worktime;
            const tabName = app.state.tabs.find(t => (app.state.workspaces[t.id] || []).some(c => c.id === card.id))?.name || '';
            const lines = [];
            const add = (label, v) => { const t = String(v ?? '').trim(); if (t) lines.push(`${label}：${t}`); };
            lines.push(`【${String(card.title || '').trim() || '未命名卡片'}】`);
            add('工作區', tabName);
            add('專案', card.project);
            add('狀態', W.statusLabel(card.status));
            const s = W.plannedStart(card), e = W.plannedEnd(card);
            if (!card.isMemo && (s || e)) add('預計', s && e && s !== e ? `${s} ～ ${e}` : (s || e));
            add('要交出什麼', card.deliverable);
            add('怎樣算完成', card.acceptance);
            add('下一步', card.nextStep);
            if (card.waitingWho || card.waitingWhat) add('在等', `${card.waitingWho || ''} ${card.waitingWhat || ''}`);
            if (String(card.content || '').trim()) lines.push('', '■ 筆記', String(card.content).trim());
            const refs = app.refs.list(card);
            if (refs.length) lines.push('', '■ 參考資料', ...refs.map(r => `- ${r.title || app.refs.shortLabel(r.url)}：${r.url}`));
            const entries = [...(card.entries || [])].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
            if (entries.length) {
                lines.push('', '■ 工作紀錄');
                entries.forEach(en => {
                    const d = en.createdAt ? W.localDateString(new Date(en.createdAt)) : '';
                    lines.push(`- ${d} ${en.title || ''}`.trim());
                    if (String(en.content || '').trim()) lines.push(...String(en.content).trim().split('\n').map(x => `    ${x}`));
                });
            }
            const logs = W.getLogs(card);
            if (logs.length) {
                const byDay = {};
                logs.forEach(l => { if (l.workDate) byDay[l.workDate] = (byDay[l.workDate] || 0) + W.logMinutes(l); });
                lines.push('', `■ 工時：共 ${W.formatMinutes(W.totalMinutes(card))}`, ...Object.keys(byDay).sort().map(d => `- ${d}：${W.formatMinutes(byDay[d])}`));
            }
            if (String(card.chronicleSummary || '').trim()) lines.push('', '■ 大事記摘要', String(card.chronicleSummary).trim());
            lines.push('', `—— 由「白板 & 心流沙盒」寄出 ${new Date().toLocaleString('zh-TW', { hour12: false })}`);
            return lines.join('\n');
        },

        silentCopy(text) {
            const fallback = () => {
                try {
                    const ta = document.createElement('textarea'); ta.value = text;
                    ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta);
                    ta.select(); document.execCommand('copy'); ta.remove();
                } catch {}
            };
            try {
                if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).catch(fallback);
                else fallback();
            } catch { fallback(); }
        },

        subject(card, reason = '') {
            const d = new Date();
            return `【白板${reason ? '・' + reason : ''}】${String(card.title || '').trim() || '未命名卡片'}（${d.getMonth() + 1}/${d.getDate()}）`;
        },

        // 打開 Gmail 撰寫視窗；內容太長時，信裡放前段，完整內容同時複製到剪貼簿。
        sendCard(cardId, reason = '') {
            const card = app.worktime.getCard(cardId);
            if (!card) return false;
            const to = app.currentUser?.email || '';
            const subject = this.subject(card, reason);
            let body = this.cardText(card);
            const full = body;
            const build = b => `https://mail.google.com/mail/?view=cm&fs=1&tf=1${to ? `&to=${encodeURIComponent(to)}` : ''}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(b)}`;
            let truncated = false;
            while (build(body).length > this.GMAIL_URL_LIMIT && body.length > 200) { body = body.slice(0, Math.floor(body.length * 0.85)); truncated = true; }
            if (truncated) body += '\n\n……（內容太長，信裡只放前段。完整內容已複製到剪貼簿，請在這裡貼上取代）';
            const win = window.open(build(body), '_blank', 'noopener');
            if (truncated || !win) this.silentCopy(`${subject}\n\n${full}`);
            if (!win) {
                app.ui.toast('瀏覽器擋住了新視窗。卡片內容已複製到剪貼簿，可以自己貼到信裡寄出。', 'warn', 7000);
                return false;
            }
            app.ui.toast(truncated ? '已打開 Gmail（內容較長：完整內容已複製，請在信裡貼上），按「傳送」才會寄出' : '已打開 Gmail，確認後按「傳送」就寄出了', 'info', 6000);
            return true;
        }
    },

    // ==========================================
    // 📅 加到 Google 日曆：打開 Google 日曆的新增活動頁，按「儲存」才會加入
    // ==========================================
    gcal: {
        form: {},

        tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei'; } catch { return 'Asia/Taipei'; } },
        ymd(d) { return d.replace(/-/g, ''); },
        addDay(dateStr, n) { const W = app.worktime; const d = W.parseLocalDate(dateStr); return d ? W.localDateString(W.addDays(d, n)) : dateStr; },

        details(card) {
            const lines = [];
            const add = (l, v) => { const t = String(v ?? '').trim(); if (t) lines.push(`${l}：${t}`); };
            add('專案', card.project);
            add('要交出什麼', card.deliverable);
            add('怎樣算完成', card.acceptance);
            add('下一步', card.nextStep);
            const todos = app.sandbox.parseSubtasks(card.content).filter(t => !t.completed).slice(0, 8);
            if (todos.length) lines.push('', '待辦：', ...todos.map(t => `・${t.text}`));
            const refs = app.refs.list(card).slice(0, 5);
            if (refs.length) lines.push('', '參考資料：', ...refs.map(r => app.refs.isCardRef(r) ? `・（白板卡片）${app.refs.target(r) ? app.refs.cardName(app.refs.target(r).card) : r.title}` : `・${r.title}：${r.url}`));
            lines.push('', `白板：${location.origin}${location.pathname}`);
            return lines.join('\n');
        },

        url({ title, start, end, allDay, details }) {
            let dates;
            if (allDay) dates = `${this.ymd(start)}/${this.ymd(this.addDay(end || start, 1))}`;
            else dates = `${start.replace(/[-:]/g, '')}00/${end.replace(/[-:]/g, '')}00`;
            return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${dates}&ctz=${encodeURIComponent(this.tz())}&details=${encodeURIComponent(details)}`;
        },

        openUrl(u) {
            const win = window.open(u, '_blank', 'noopener');
            if (!win) { app.ui.toast('瀏覽器擋住了新視窗，請允許此網站開啟彈出視窗後再試一次', 'warn', 6000); return false; }
            app.ui.toast('已打開 Google 日曆，確認後按「儲存」就加進去了', 'info', 5000);
            return true;
        },

        async open(cardId) {
            const card = app.worktime.getCard(cardId);
            if (!card) return;
            const W = app.worktime;
            const esc = s => app.entries.escapeHtml(s);
            const today = W.localDateString();
            const ps = W.plannedStart(card), pe = W.plannedEnd(card);
            const pm = Math.round(W.plannedMinutes(card));
            const dur = pm > 0 ? Math.min(pm, 8 * 60) : 60;
            this.form = { mode: 'block', date: ps && ps >= today ? ps : today, time: '10:00', minutes: dur };
            const durOpts = [30, 60, 90, 120, 180, 240].concat(dur).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
            const choice = await app.ui.dialog({
                title: `📅 加到 Google 日曆：${String(card.title || '').trim() || '未命名卡片'}`,
                html: `
                    <label class="gcal-opt"><input type="radio" name="gcal-mode" value="block" checked onchange="app.gcal.form.mode=this.value"> <b>指定時段</b>（時間任務：把時間保留下來）</label>
                    <div class="gcal-row">
                        <input type="date" class="task-meta-input" value="${esc(this.form.date)}" onchange="app.gcal.form.date=this.value">
                        <input type="time" class="task-meta-input" value="10:00" step="900" onchange="app.gcal.form.time=this.value">
                        <select class="task-meta-input" onchange="app.gcal.form.minutes=Number(this.value)">${durOpts.map(m => `<option value="${m}" ${m === dur ? 'selected' : ''}>${W.formatMinutes(m)}</option>`).join('')}</select>
                    </div>
                    ${pm > 0 ? `<div class="data-note">長度預設用這張卡的預估工時（${W.formatMinutes(pm)}${pm > 480 ? '，超過 8 小時先排 8 小時，建議分幾段排' : ''}）。</div>` : ''}
                    <label class="gcal-opt"><input type="radio" name="gcal-mode" value="allday" ${ps ? '' : 'disabled'} onchange="app.gcal.form.mode=this.value"> <b>整天</b>（${ps ? `${esc(ps)}${pe && pe !== ps ? ` ～ ${esc(pe)}` : ''}，用卡片的預計日期` : '這張卡還沒有預計日期'}）</label>
                    <p class="data-note">說明欄會帶入：要交出什麼、完成標準、下一步、未完成的待辦、參考資料連結。</p>`,
                buttons: [{ label: '取消', value: null }, { label: '打開 Google 日曆', value: 'go', primary: true }]
            });
            if (!choice) return;
            const f = this.form;
            const title = String(card.title || '').trim() || '未命名卡片';
            let ok;
            if (f.mode === 'allday' && ps) {
                ok = this.openUrl(this.url({ title, start: ps, end: pe || ps, allDay: true, details: this.details(card) }));
            } else {
                const date = W.parseLocalDate(f.date) ? f.date : today;
                const [h, m] = String(f.time || '10:00').split(':').map(Number);
                const startD = new Date(W.parseLocalDate(date)); startD.setHours(h || 0, m || 0, 0, 0);
                const endD = new Date(startD.getTime() + (Number(f.minutes) || 60) * 60000);
                const fmt = d => `${W.localDateString(d)}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
                ok = this.openUrl(this.url({ title, start: fmt(startD), end: fmt(endD), allDay: false, details: this.details(card) }));
            }
            if (ok) {
                card.calendarAddedAt = new Date().toISOString();
                app.saveToLocal();
            }
        },

        // 等別人：在追蹤日加一個 15 分鐘的提醒
        followUp(cardId) {
            const card = app.worktime.getCard(cardId);
            if (!card) return;
            const W = app.worktime;
            const who = String(card.waitingWho || '').trim(), what = String(card.waitingWhat || '').trim();
            const date = W.parseLocalDate(card.followUpDate) ? card.followUpDate : W.localDateString();
            const title = `追：${who ? '等' + who : '等回覆'}${what ? '（' + what + '）' : ''}｜${String(card.title || '').trim()}`;
            const details = `${who ? `在等：${who}\n` : ''}${what ? `等什麼：${what}\n` : ''}\n${this.details(card)}`;
            this.openUrl(this.url({ title, start: `${date}T0930`, end: `${date}T0945`, allDay: false, details }));
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
            if (id === 'main') { app.ui.toast('「主工作區」不能刪除'); return; }
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
                // 🛡 卡片會跟著刪：要打工作區名稱確認，避免手滑
                this._typed = '';
                const typed = await app.ui.dialog({
                    title: '🛡 確認刪除',
                    html: `<p>會連同 <b>${c.cards}</b> 張卡片一起刪除。請輸入工作區名稱「<b>${esc(tab.name)}</b>」確認：</p>
                        <input class="task-meta-input" id="ws-del-name" autocomplete="off" oninput="app.tabsManager._typed=this.value" style="width:100%;">`,
                    buttons: [{ label: '取消', value: null }, { label: '刪除', value: 'ok', danger: true }]
                });
                if (typed !== 'ok' || this._typed.trim() !== String(tab.name).trim()) { if (typed === 'ok') app.ui.toast('名稱不一樣，沒有刪除', 'warn'); return; }
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
            if (field === 'content') { clearTimeout(this._badgeT); this._badgeT = setTimeout(() => app.updateCardBadges(id), 300); }
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
                const choice = await app.ui.dialog({
                    title: '刪除卡片',
                    html: `<p>刪除「${app.entries.escapeHtml(card.title || '未命名卡片')}」${mins ? `（含 ${app.worktime.formatMinutes(mins)} 工時紀錄）` : ''}？</p><p>要長期留存的內容（規則、連結、處理經過），可以先寄一份給自己。刪除後也會先放進「🗂 資料 → 最近刪除」。</p>`,
                    buttons: [
                        { label: '取消', value: null },
                        { label: '直接刪除', value: 'delete', danger: true },
                        { label: '✉️ 寄給自己再刪除', value: 'mail', primary: true }
                    ]
                });
                if (!choice) return;
                if (choice === 'mail') app.mail.sendCard(id, '封存');
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

        addMatrixNode() { app.board.addFromInput(); },
        updateMatrixNodePos(id, gridX, gridY) { app.board.move(id, gridX, gridY); },

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
// 📅 今日：分類（必做／備選／今天不做）→ 排程板（時段）→ 專注。資料存在卡片上（card.plans[日期]、card.taskType、card.fixed）
// ==========================================
app.today = {
    TYPES: {
        analysis: { icon: '🧮', name: '分析', slot: 'am', est: 60, q: '規則清楚，但要很專心、不能出錯？' },
        research: { icon: '🔬', name: '研究', slot: 'am', est: 60, q: '還不知道答案，要摸索、查資料、試試看？' },
        creative: { icon: '🎨', name: '創造', slot: 'pm', est: 60, q: '要從無到有，產出新的東西？' },
        comm: { icon: '💬', name: '溝通', slot: 'low', est: 30, q: '主要是在跟人對話、確認、協調？' },
        chores: { icon: '🧹', name: '雜物', slot: 'low', est: 15, q: '不太需要動腦，但總得做完？' }
    },
    TYPE_ORDER: ['analysis', 'research', 'creative', 'comm', 'chores'],
    DEEP: ['analysis', 'research', 'creative'],
    SLOT_ORDER: ['am', 'low', 'pm'],
    DEFAULT_SLOTS: {
        am: { name: '上午高峰', from: '09:30', to: '11:30' },
        low: { name: '午後低谷', from: '13:30', to: '15:00' },
        pm: { name: '下午後段', from: '15:30', to: '17:30' }
    },
    EST_OPTIONS: [15, 30, 45, 60, 90, 120, 180, 240],
    LIMIT_MUST: 4, LIMIT_OPT: 3,
    ui: { which: null, search: '', showSkipped: false, showSettings: false, collapsed: {} },
    groupBy() { return app.prefs.todayGroupBy === 'urgency' ? 'urgency' : 'project'; },
    setGroupBy(v) { app.prefs.todayGroupBy = v; app.store.savePrefs(); this.render(); },
    toggleGroup(k) { this.ui.collapsed[k] = !this.ui.collapsed[k]; this.render(); },
    skipGroup(ids) { const date = this.date(); ids.forEach(id => { const c = this.W().getCard(id); if (c) { this.setPlan(c, date, { pri: 'skip', slot: null, est: this.planOf(c, date)?.est || this.defaultEst(c), done: false }); } }); app.saveToLocal(); this.render(); app.ui.toast(`${ids.length} 張今天不做`); },

    esc(s) { return app.entries.escapeHtml(s); },
    W() { return app.worktime; },
    name(card) { return app.cardLabel(card); },
    addDays(dateStr, n) { const d = this.W().parseLocalDate(dateStr); d.setDate(d.getDate() + n); return this.W().localDateString(d); },
    todayStr() { return this.W().localDateString(); },
    // 預設：下午五點後打開＝排明天
    which() { if (!this.ui.which) this.ui.which = new Date().getHours() >= 17 ? 'tomorrow' : 'today'; return this.ui.which; },
    date() { return this.which() === 'tomorrow' ? this.addDays(this.todayStr(), 1) : this.todayStr(); },
    dateLabel(d) { const x = this.W().parseLocalDate(d); return `${x.getMonth() + 1}/${x.getDate()}（${'日一二三四五六'[x.getDay()]}）`; },
    weekKey(dateStr) {
        const d = this.W().parseLocalDate(dateStr);
        const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
        const y = t.getUTCFullYear(), wk = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
        return `${y}-W${String(wk).padStart(2, '0')}`;
    },

    // ---------- 設定（時段、預算）：記在這台電腦 ----------
    slots() {
        const p = app.settings.get('todaySlots') || {};
        const out = {};
        this.SLOT_ORDER.forEach(k => { out[k] = { ...this.DEFAULT_SLOTS[k], ...(p[k] || {}) }; });
        return out;
    },
    mins(hhmm) { const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; },
    cap(k) { const s = this.slots()[k]; return Math.max(0, this.mins(s.to) - this.mins(s.from)); },
    defaultBudget() { const b = Number(app.settings.get('todayBudget')); return b > 0 ? b : 300; },
    // 某一天可以覆寫（請假、半天、出差）
    budget(date = this.date()) { const o = Number(app.daylog.get(date).budget); return o > 0 ? o : this.defaultBudget(); },
    async setDayBudget() {
        const date = this.date(), cur = Math.round(this.budget(date) / 6) / 10, def = Math.round(this.defaultBudget() / 6) / 10;
        this._dayBudget = cur;
        const v = await app.ui.dialog({
            title: `${this.dateLabel(date)} 可以專心幾小時？`,
            html: `<p class="pm-hint" style="margin-top:0;">請假、半天、出差、整天開會時，只改這一天。平常是 ${def} 小時（在 ⚙ 時段設定改）。</p>
                <div class="qa-fields"><label>小時<input type="number" min="0.5" max="12" step="0.5" value="${cur}" oninput="app.today._dayBudget=this.value"></label></div>`,
            buttons: [{ label: '取消', value: null }, { label: '恢復平常', value: 'reset' }, { label: '只改這天', value: 'ok', primary: true }]
        });
        if (v === 'reset') app.daylog.set(date, { budget: 0 });
        else if (v === 'ok') { const m = Math.round(Number(this._dayBudget) * 60); if (m > 0) app.daylog.set(date, { budget: m }); }
        this.render();
    },
    setSlotPref(k, field, v) {
        const cur = { ...(app.settings.get('todaySlots') || {}) };
        cur[k] = { ...(cur[k] || {}), [field]: v };
        app.settings.set('todaySlots', cur); this.render();
    },
    setBudget(h) { const v = Math.round(Number(h) * 60); if (v > 0) { app.settings.set('todayBudget', v); this.render(); } },

    // ---------- 卡片上的資料 ----------
    planOf(card, date = this.date()) { return card?.plans && typeof card.plans === 'object' ? card.plans[date] || null : null; },
    setPlan(card, date, patch) {
        if (!card.plans || typeof card.plans !== 'object') card.plans = {};
        const cur = card.plans[date] || {};
        card.plans[date] = { ...cur, ...patch };
        // 只留最近 21 天，資料量不會長大
        const keep = this.addDays(this.todayStr(), -21);
        Object.keys(card.plans).forEach(d => { if (d < keep) delete card.plans[d]; });
    },
    typeOf(card) { return this.TYPES[card?.taskType] ? card.taskType : ''; },
    defaultEst(card) {
        const t = this.typeOf(card);
        const pm = Number(card.plannedMinutes) || 0;
        if (pm > 0 && pm <= 120) return pm;
        return t ? this.TYPES[t].est : 60;
    },
    // 統一：勾選＝這件事（整張卡）完成。做了一部分不用勾，計時會記下今天做了多久，沒完成的隔天自動回到候選。
    isDone(card) { return Number(card.status) === 2; },
    minutesOn(card, date) { return Math.round(this.W().dailyMinutesMap(card)[date] || 0); },

    // 完全空白的卡（沒標題、沒內容、沒工時）不列進今日；另外提示可以清掉
    rows() { return this.W().allCards().filter(({ card, tabId }) => !/^♻/.test(app.state.tabs.find(t => t.id === tabId)?.name || '') && !app.sync.isBlankCard(card) && !app.projectReg.isClosed(card.project)); },
    blankCount() { return app.dataCenter.blankCards().length; },
    async clearBlanks() { await app.dataCenter.removeBlanks(); this.render(); },
    // 固定項的週期：每天／平日／每週幾／每月幾號
    fixedOn(card, date) {
        const f = card.fixed || {}, d = this.W().parseLocalDate(date), dow = d.getDay();
        if (f.rule === 'weekdays') return dow >= 1 && dow <= 5;
        if (f.rule === 'weekly') return Array.isArray(f.days) && f.days.includes(dow);
        if (f.rule === 'monthly') { const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); return Math.min(Number(f.dom) || 1, last) === d.getDate(); }
        return true;
    },
    ruleText(f = {}) {
        if (f.rule === 'weekdays') return '平日';
        if (f.rule === 'weekly') return '每週' + (f.days || []).map(x => '日一二三四五六'[x]).join('、');
        if (f.rule === 'monthly') return `每月 ${f.dom || 1} 號`;
        return '每天';
    },
    fixedRows(date = this.date()) { return this.rows().filter(({ card }) => card.fixed && Number(card.status) !== 2 && this.fixedOn(card, date)); },
    plannedRows(date = this.date()) {
        return this.rows().filter(({ card }) => !card.fixed && ['must', 'opt'].includes(this.planOf(card, date)?.pri));
    },

    // 候選：之前沒做完、快到期、進行中、有下一步、有未完成待辦、本週重點、剛新增
    // 在追的事：等別人的卡。不算逾期、不提醒沒做完，到追蹤日才跳到前面。
    isWaiting(card) { return !!(String(card.waitingWho || '').trim() || String(card.waitingWhat || '').trim() || Number(card.status) === 3); },
    reasons(card, date) {
        const W = this.W(), r = [];
        if (this.isWaiting(card)) {
            const who = String(card.waitingWho || '').trim(), what = String(card.waitingWhat || '').trim(), fu = String(card.followUpDate || '');
            const label = `等${who ? ' ' + who : ''}${what ? '：' + what : ''}` + (who || what ? '' : '（卡住／等待）');
            if (fu && fu <= date) r.push({ k: 'chase', t: `⏳ 今天要追：${label}`, w: 88 });
            else r.push({ k: 'wait', t: `⏳ ${label}${fu ? `（${fu.slice(5).replace('-', '/')} 追）` : '（沒設追蹤日）'}`, w: 20 });
            if (card.weekFocus === this.weekKey(date)) r.push({ k: 'star', t: '⭐ 本週重點', w: 85 });
            return r;
        }
        const prev = Object.entries(card.plans || {}).filter(([d, p]) => d < date && ['must', 'opt'].includes(p?.pri)).sort().pop();
        if (prev) r.push({ k: 'carry', t: `${prev[0].slice(5).replace('-', '/')} 沒做完`, w: 100 });
        const end = card.isMemo ? '' : W.plannedEnd(card);
        if (end) {
            const n = Math.round((W.parseLocalDate(end) - W.parseLocalDate(date)) / 864e5);
            if (n < 0 && n >= -30) r.push({ k: 'due', t: `過期 ${-n} 天`, w: 90 });
            else if (n === 0) r.push({ k: 'due', t: '當天截止', w: 95 });
            else if (n > 0 && n <= 7) r.push({ k: 'due', t: `${n} 天後截止`, w: 80 - n });
        }
        if (card.weekFocus === this.weekKey(date)) r.push({ k: 'star', t: '⭐ 本週重點', w: 85 });
        if (Number(card.status) === 1) r.push({ k: 'doing', t: '進行中', w: 40 });
        if (String(card.nextStep || '').trim()) r.push({ k: 'next', t: '有下一步', w: 30 });
        const open = app.sandbox.parseSubtasks(card.content).filter(s => !s.completed).length;
        if (open) r.push({ k: 'todo', t: `待辦 ${open}`, w: 25 });
        const ts = Number(String(card.id).match(/(\d{10,})/)?.[1] || 0);
        if (ts && Date.now() - ts < 2 * 864e5) r.push({ k: 'new', t: '剛新增', w: 50 });
        return r;
    },
    candidates(date = this.date()) {
        const q = this.ui.search.trim().toLowerCase();
        const cnt = {};
        this.rows().forEach(({ card }) => { if (Number(card.status) !== 2) { const n = app.quickAdd.norm(card.title); if (n) cnt[n] = (cnt[n] || 0) + 1; } });
        this._dupCount = cnt;
        return this.rows().filter(({ card }) => !card.fixed && Number(card.status) !== 2 && !this.planOf(card, date))
            .map(r => ({ ...r, why: this.reasons(r.card, date) }))
            .filter(r => !q || [r.card.title, r.card.project, r.tabName].some(x => String(x || '').toLowerCase().includes(q)))
            .sort((a, b) => Math.max(0, ...b.why.map(x => x.w)) - Math.max(0, ...a.why.map(x => x.w)));
    },
    skippedRows(date = this.date()) { return this.rows().filter(({ card }) => !card.fixed && this.planOf(card, date)?.pri === 'skip'); },

    // ---------- 動作 ----------
    save(cardId) { app.saveToLocal(); if (cardId) app.refreshCard(cardId); this.render(); app.sandbox.renderTodo?.(); },
    classify(cardId, pri, date = this.date()) {
        const card = this.W().getCard(cardId);
        if (!card) return;
        const cur = this.planOf(card, date) || {};
        const t = this.typeOf(card);
        this.setPlan(card, date, {
            pri,
            slot: pri === 'skip' ? null : (cur.slot || (t ? this.TYPES[t].slot : null)),
            est: cur.est || this.defaultEst(card),
            done: !!cur.done
        });
        this.save(cardId);
    },
    unplan(cardId, date = this.date()) {
        const card = this.W().getCard(cardId);
        if (!card?.plans?.[date]) return;
        delete card.plans[date];
        this.save(cardId);
    },
    setType(cardId, type) {
        const card = this.W().getCard(cardId);
        if (!card) return;
        if (type && !this.TYPES[type]) return;
        if (type) card.taskType = type; else delete card.taskType;
        const p = this.planOf(card);
        if (type && p && ['must', 'opt'].includes(p.pri) && !p.slot) this.setPlan(card, this.date(), { slot: this.TYPES[type].slot });
        this.save(cardId);
    },
    setSlot(cardId, slot) {
        const card = this.W().getCard(cardId);
        if (!card) return;
        if (card.fixed) { card.fixed = { ...card.fixed, slot: slot || null }; return this.save(cardId); }
        this.setPlan(card, this.date(), { slot: this.SLOT_ORDER.includes(slot) ? slot : null });
        this.save(cardId);
    },
    setEst(cardId, v) {
        const card = this.W().getCard(cardId);
        const m = Math.max(0, Math.round(Number(v) || 0));
        if (!card || !m) return;
        if (card.fixed) card.fixed = { ...card.fixed, est: m };
        else this.setPlan(card, this.date(), { est: m });
        this.save(cardId);
    },
    toggleDone(cardId) {
        const card = this.W().getCard(cardId);
        if (!card) return;
        const date = this.date();
        if (card.fixed) {
            const list = Array.isArray(card.fixedDone) ? card.fixedDone.filter(d => d >= this.addDays(this.todayStr(), -120)) : [];
            card.fixedDone = list.includes(date) ? list.filter(d => d !== date) : [...list, date].sort();
            return this.save(cardId);
        }
        if (this.isDone(card)) { this.W().reopenCompleted(card, 1); this.save(cardId); app.ui.toast(`「${this.name(card)}」重新打開`); }
        else this.completeCard(cardId);
    },
    fixedDoneOn(card, date = this.date()) { return Array.isArray(card.fixedDone) && card.fixedDone.includes(date); },
    // 候選裡直接把整張卡標成完成（可復原）
    completeCard(cardId) {
        const card = this.W().getCard(cardId);
        if (!card) return;
        const prev = { status: card.status, progress: card.progress, actualStart: card.actualStart, actualEnd: card.actualEnd };
        this.W().markCompleted(card);
        this.save(cardId);
        app.ui.banner('info', `✅「${this.name(card)}」標記完成`, [{ label: '復原', action: () => {
            const c = this.W().getCard(cardId);
            if (!c) return;
            ['status', 'progress', 'actualStart', 'actualEnd'].forEach(k => { if (prev[k] === undefined) delete c[k]; else c[k] = prev[k]; });
            this.save(cardId);
        } }], 'td-done');
        clearTimeout(this._doneT);
        this._doneT = setTimeout(() => app.ui.clearBanner('td-done'), 8000);
    },

    toggleStar(cardId) {
        const card = this.W().getCard(cardId);
        if (!card) return;
        const wk = this.weekKey(this.date());
        if (card.weekFocus === wk) delete card.weekFocus; else card.weekFocus = wk;
        this.save(cardId);
    },
    focus(cardId) { app.sandbox.focusTaskForTimer(cardId); },

    async brainDump() {
        const el = document.getElementById('td-dump');
        const all = String(el?.value || '').split('\n').map(t => t.replace(/^\s*(?:[-*•・]\s+(?:\[[ xX]\]\s*)?|\d{1,2}[.)、．]\s*)/, '').trim()).filter(Boolean);
        if (!all.length) return;
        const lines = await app.quickAdd.confirmNew(all);
        if (!lines) return;
        if (!lines.length) { this.ui.dump = ''; this.render(); return; }
        lines.forEach(title => app.quickAdd.create({ title, tabId: app.state.activeTabId }));
        app.saveToLocal();
        this.ui.dump = '';
        this.render();
        setTimeout(() => document.getElementById('td-dump')?.focus(), 0);
        app.ui.toast(`已新增 ${lines.length} 張卡，在下面分類`);
    },

    // ⚡ 被打斷：快速記一筆（記到某張卡；不選就記到「臨時插件」卡），會出現在收工帳單的計畫外
    async interrupt() {
        const f = { what: '', min: 15, cardId: '' };
        this._intForm = f;
        const open = this.W().allCards().filter(({ card }) => Number(card.status) !== 2 && !app.sync.isBlankCard(card) && !card.fixed).slice(0, 80);
        const v = await app.ui.dialog({
            title: '⚡ 被打斷',
            html: `<p class="pm-hint" style="margin-top:0;">臨時插進來的事，10 秒記一筆。收工帳單會算進「計畫外」。</p>
                <div class="qa-fields"><label style="flex:2;">什麼事<input id="td-int-what" placeholder="例如：長官臨時要資料" oninput="app.today._intForm.what=this.value"></label></div>
                <div class="fx-days">${[5, 10, 15, 30, 60].map(m => `<label><input type="radio" name="int-min" ${m === 15 ? 'checked' : ''} onchange="app.today._intForm.min=${m}">${m} 分</label>`).join('')}<label>其他<input type="number" min="1" style="width:64px;" oninput="app.today._intForm.min=Number(this.value)||15"></label></div>
                <div class="qa-fields"><label style="flex:2;">記到哪張卡<select onchange="app.today._intForm.cardId=this.value"><option value="">臨時插件（自動）</option>${open.map(({ card }) => `<option value="${card.id}">${this.esc(this.name(card))}</option>`).join('')}</select></label></div>`,
            buttons: [{ label: '取消', value: null }, { label: '記下來', value: 'ok', primary: true }]
        });
        if (v !== 'ok') return;
        let cardId = f.cardId;
        if (!cardId) {
            let card = this.W().allCards().map(r => r.card).find(c => c.title === '臨時插件' && Number(c.status) !== 2);
            if (!card) { card = app.quickAdd.create({ title: '臨時插件', tabId: app.state.activeTabId, project: '日常' }); card.taskType = 'chores'; }
            cardId = card.id;
        }
        const ok = this.W().addTimerLog(cardId, Math.max(1, Number(f.min) || 15) * 60, `⚡ ${String(f.what || '臨時插件').trim()}`);
        app.saveToLocal();
        this.render();
        app.ui.toast(ok ? `已記下 ${f.min} 分鐘的插件` : '沒有記成功', ok ? 'info' : 'warn');
    },

    addFixed() { return this.editFixed(null); },
    async editFixed(cardId) {
        const card = cardId ? this.W().getCard(cardId) : null;
        const cf = card?.fixed || {};
        const f = { title: card ? this.name(card) : '', slot: cf.slot || 'am', est: cf.est || 30, rule: cf.rule || 'daily', days: [...(cf.days || [1])], dom: cf.dom || 1 };
        this._fixedForm = f;
        const esc = x => this.esc(x);
        const v = await app.ui.dialog({
            title: card ? '修改固定項' : '＋ 固定項',
            html: `<p class="pm-hint" style="margin-top:0;">固定要做的事（晨會、週會、月報…）。到了那天會自動出現在排程板、先扣掉時間，可以打勾。</p>
                <div class="qa-fields">
                    <label style="flex:2;">名稱<input id="td-fixed-title" value="${esc(f.title)}" placeholder="例如：晨會、雙週會報告、月報" oninput="app.today._fixedForm.title=this.value" ${card ? 'disabled' : ''}></label>
                    <label>時段<select onchange="app.today._fixedForm.slot=this.value">${this.SLOT_ORDER.map(k => `<option value="${k}" ${k === f.slot ? 'selected' : ''}>${esc(this.slots()[k].name)}</option>`).join('')}</select></label>
                    <label>分鐘<input type="number" min="5" step="5" value="${f.est}" oninput="app.today._fixedForm.est=this.value"></label>
                </div>
                <div class="qa-fields">
                    <label>多久一次<select onchange="app.today._fixedForm.rule=this.value; document.getElementById('fx-days').style.display=this.value==='weekly'?'flex':'none'; document.getElementById('fx-dom').style.display=this.value==='monthly'?'flex':'none';">
                        ${[['daily', '每天'], ['weekdays', '平日（一～五）'], ['weekly', '每週幾'], ['monthly', '每月幾號']].map(([k, l]) => `<option value="${k}" ${k === f.rule ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
                    <label id="fx-dom" style="display:${f.rule === 'monthly' ? 'flex' : 'none'};">幾號<input type="number" min="1" max="31" value="${f.dom}" oninput="app.today._fixedForm.dom=Number(this.value)"></label>
                </div>
                <div id="fx-days" class="fx-days" style="display:${f.rule === 'weekly' ? 'flex' : 'none'};">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label><input type="checkbox" ${f.days.includes(d) ? 'checked' : ''} onchange="const a=app.today._fixedForm.days; if(this.checked){ if(!a.includes(${d})) a.push(${d}); } else { a.splice(a.indexOf(${d}),1); }">週${'日一二三四五六'[d]}</label>`).join('')}</div>`,
            buttons: [{ label: '取消', value: null }, { label: card ? '儲存' : '加入', value: 'ok', primary: true }]
        });
        if (v !== 'ok') return;
        const fixed = { slot: f.slot, est: Math.max(5, Math.round(Number(f.est) || 30)), rule: f.rule };
        if (f.rule === 'weekly') fixed.days = f.days.length ? f.days.sort() : [1];
        if (f.rule === 'monthly') fixed.dom = Math.min(31, Math.max(1, Number(f.dom) || 1));
        let target = card;
        if (!target) {
            if (!f.title.trim()) return;
            target = app.quickAdd.create({ title: f.title.trim(), tabId: app.state.activeTabId, project: '固定' });
        }
        target.fixed = { ...(target.fixed || {}), ...fixed };
        if (fixed.rule !== 'weekly') delete target.fixed.days;
        if (fixed.rule !== 'monthly') delete target.fixed.dom;
        app.saveToLocal();
        this.render();
        app.ui.toast(`${card ? '已更新' : '已加入'}固定項「${this.name(target)}」（${this.ruleText(target.fixed)}）`);
    },
    async removeFixed(cardId) {
        const card = this.W().getCard(cardId);
        if (!card) return;
        if (!await app.ui.confirm('取消固定', `<p>「${this.esc(this.name(card))}」不再每天出現？卡片本身不會刪除。</p>`, '取消固定')) return;
        delete card.fixed;
        this.save(cardId);
    },

    // ---------- 會議／外出（只有那一天，不是卡片，只用來扣時間） ----------
    meetings(date = this.date()) { const m = app.daylog.get(date).meetings; return Array.isArray(m) ? m : []; },
    async addMeeting() {
        const date = this.date();
        const f = { title: '', slot: 'pm', min: 60 };
        this._mtgForm = f;
        const v = await app.ui.dialog({
            title: `＋ 會議／外出（${this.dateLabel(date)}）`,
            html: `<p class="pm-hint" style="margin-top:0;">只佔這一天的時間，用來扣掉可專心的時數；不會變成卡片。要記工時的會議，還是用卡片計時。</p>
                <div class="qa-fields">
                    <label style="flex:2;">名稱<input id="td-mtg-title" placeholder="例如：化學署週會" oninput="app.today._mtgForm.title=this.value"></label>
                    <label>時段<select onchange="app.today._mtgForm.slot=this.value">${this.SLOT_ORDER.map(k => `<option value="${k}" ${k === 'pm' ? 'selected' : ''}>${this.esc(this.slots()[k].name)}</option>`).join('')}</select></label>
                    <label>分鐘<input type="number" min="5" step="5" value="60" oninput="app.today._mtgForm.min=this.value"></label>
                </div>`,
            buttons: [{ label: '取消', value: null }, { label: '加入', value: 'ok', primary: true }]
        });
        if (v !== 'ok' || !f.title.trim()) return;
        const list = [...this.meetings(date), { id: app.makeId('mtg'), title: f.title.trim(), slot: f.slot, min: Math.max(5, Math.round(Number(f.min) || 60)) }];
        app.daylog.set(date, { meetings: list });
        this.render();
    },
    removeMeeting(id) { const date = this.date(); app.daylog.set(date, { meetings: this.meetings(date).filter(m => m.id !== id) }); this.render(); },

    // ---------- 統計與提醒 ----------
    summary(date = this.date()) {
        const planned = this.plannedRows(date).map(r => ({ ...r, p: this.planOf(r.card, date) }));
        const fixed = this.fixedRows(date);
        const meetings = this.meetings(date);
        const must = planned.filter(r => r.p.pri === 'must'), opt = planned.filter(r => r.p.pri === 'opt');
        const total = planned.reduce((s, r) => s + (Number(r.p.est) || 0), 0) + fixed.reduce((s, r) => s + (Number(r.card.fixed.est) || 0), 0);
        const bySlot = {};
        this.SLOT_ORDER.forEach(k => { bySlot[k] = 0; });
        planned.forEach(r => { if (bySlot[r.p.slot] !== undefined) bySlot[r.p.slot] += Number(r.p.est) || 0; });
        fixed.forEach(r => { if (bySlot[r.card.fixed.slot] !== undefined) bySlot[r.card.fixed.slot] += Number(r.card.fixed.est) || 0; });
        meetings.forEach(m => { if (bySlot[m.slot] !== undefined) bySlot[m.slot] += Number(m.min) || 0; });
        const mtgMin = meetings.reduce((a, m) => a + (Number(m.min) || 0), 0);
        const done = planned.filter(r => this.isDone(r.card)).length + fixed.filter(r => this.fixedDoneOn(r.card, date)).length;
        return { planned, fixed, meetings, must, opt, total: total + mtgMin, bySlot, done, count: planned.length + fixed.length };
    },
    warnings(date = this.date()) {
        const S = this.summary(date), out = [], slots = this.slots(), W = this.W();
        const h = m => `${Math.round(m / 6) / 10} 小時`;
        if (S.total > this.budget(date)) out.push(`預估 ${h(S.total)}，超過 ${h(this.budget(date))}。考慮把一件必做改成備選或明天。`);
        if (S.must.length > this.LIMIT_MUST) out.push(`必做 ${S.must.length} 件，超過 ${this.LIMIT_MUST} 件。`);
        if (S.opt.length > this.LIMIT_OPT) out.push(`備選 ${S.opt.length} 件，超過 ${this.LIMIT_OPT} 件。`);
        this.SLOT_ORDER.forEach(k => { const c = this.cap(k); if (c && S.bySlot[k] > c) out.push(`「${slots[k].name}」排了 ${S.bySlot[k]} 分鐘，容量 ${c} 分鐘。`); });
        S.planned.filter(r => r.p.slot === 'low' && this.DEEP.includes(this.typeOf(r.card)) && !this.isDone(r.card)).forEach(r =>
            out.push(`「${this.name(r.card)}」是${this.TYPES[this.typeOf(r.card)].name}型，放在「${slots.low.name}」容易卡住。`));
        const deepAm = S.planned.filter(r => r.p.slot === 'am' && this.DEEP.includes(this.typeOf(r.card)));
        const amCap = this.cap('am');
        if (deepAm.length >= 2 && amCap && deepAm.reduce((s, r) => s + (Number(r.p.est) || 0), 0) > amCap) out.push(`「${slots.am.name}」排了 ${deepAm.length} 件需要專心的事，放不下，建議移一件到「${slots.pm.name}」。`);
        const tomorrow = this.addDays(date, 1);
        this.rows().filter(({ card }) => !card.fixed && Number(card.status) !== 2 && !card.isMemo && W.plannedEnd(card) && W.plannedEnd(card) <= tomorrow && W.plannedEnd(card) >= this.addDays(date, -30) && this.planOf(card, date)?.pri !== 'must')
            .slice(0, 3).forEach(({ card }) => out.push(`「${this.name(card)}」${W.plannedEnd(card).slice(5).replace('-', '/')} 截止，還沒排進必做。`));
        return out;
    },

    // ---------- 畫面 ----------
    typeSelect(card) {
        const t = this.typeOf(card);
        return `<select class="td-type ${t ? 'set' : ''}" onchange="app.today.setType('${card.id}', this.value)" title="任務類型：決定放哪個時段">
            <option value="">類型？</option>${this.TYPE_ORDER.map(k => `<option value="${k}" ${k === t ? 'selected' : ''}>${this.TYPES[k].icon} ${this.TYPES[k].name}</option>`).join('')}</select>`;
    },
    estSelect(cardId, est) {
        const opts = [...new Set([...this.EST_OPTIONS, Number(est) || 0])].filter(Boolean).sort((a, b) => a - b);
        const lbl = m => m >= 60 ? `${Math.round(m / 6) / 10}h` : `${m}m`;
        return `<select class="td-est" onchange="app.today.setEst('${cardId}', this.value)" title="預估時間">${opts.map(m => `<option value="${m}" ${m === Number(est) ? 'selected' : ''}>${lbl(m)}</option>`).join('')}</select>`;
    },
    slotSelect(cardId, slot) {
        const s = this.slots();
        return `<select class="td-slot-sel" onchange="app.today.setSlot('${cardId}', this.value)" title="時段"><option value="">未排時段</option>${this.SLOT_ORDER.map(k => `<option value="${k}" ${k === slot ? 'selected' : ''}>${this.esc(s[k].name)}</option>`).join('')}</select>`;
    },

    candidateRow({ card, tabName, why }, showProject = true) {
        const esc = x => this.esc(x);
        const wk = this.weekKey(this.date());
        const parent = card.parentId ? this.W().getCard(card.parentId) : null;
        const meta = [showProject && card.project ? `#${esc(card.project)}` : '', showProject ? esc(tabName) : '', parent ? `↰ ${esc(parent.title || '母卡')}` : ''].filter(Boolean).join(' · ');
        const urgent = why.some(x => x.k === 'carry' || x.k === 'chase' || (x.k === 'due' && x.w >= 79));
        const waiting = why.some(x => x.k === 'wait' || x.k === 'chase');
        const dup = (this._dupCount || {})[app.quickAdd.norm(card.title)] > 1;
        why = dup ? [...why, { k: 'dup', t: '可能重複', w: 0 }] : why;
        return `<div class="td-cand ${urgent ? 'urgent' : ''} ${why.some(x => x.k !== 'dup') ? '' : 'quiet'}" draggable="true" ondragstart="if(event.target===this) app.today.dragStart(event,'${card.id}')" title="可以直接拖到右邊的時段">
            <input type="checkbox" class="td-complete" onchange="app.today.completeCard('${card.id}')" title="這張卡已經做完了（標記完成）">
            <button type="button" class="td-star ${card.weekFocus === wk ? 'on' : ''}" onclick="app.today.toggleStar('${card.id}')" title="本週重點">${card.weekFocus === wk ? '★' : '☆'}</button>
            <div class="td-cand-text">
                <div class="td-title" title="${esc(card.title || '')}">${esc(this.name(card))}</div>
                <div class="td-meta">${meta}${meta && why.length ? ' · ' : ''}${why.filter(x => x.k !== 'star').map(x => `<span class="td-why ${x.k}">${esc(x.t)}</span>`).join(' ')}</div>
            </div>
            ${this.typeSelect(card)}
            <div class="td-pri">
                <button type="button" class="must" onclick="app.today.classify('${card.id}','must')" title="必做">必做</button>
                <button type="button" class="opt" onclick="app.today.classify('${card.id}','opt')" title="備選">備選</button>
                <button type="button" class="skip" onclick="app.today.classify('${card.id}','skip')" title="今天不做">不做</button>
            </div>
            <button type="button" class="td-waitbtn ${waiting ? 'on' : ''}" onclick="app.today.editWaiting('${card.id}')" title="${waiting ? '改等誰、追蹤日，或不用等了' : '這件事在等別人 → 放到「在追的事」'}">⏳</button>
            <button type="button" class="td-del" onclick="app.actions.deleteCard('${card.id}')" title="刪除這張卡（可在「資料 → 最近刪除」救回）">🗑</button>
        </div>`;
    },

    async editWaiting(id) {
        const card = this.W().getCard(id); if (!card) return;
        const was = this.isWaiting(card);
        const f = { who: card.waitingWho || '', what: card.waitingWhat || '', fu: card.followUpDate || this.addDays(this.todayStr(), 3) };
        this._waitForm = f;
        const esc = x => this.esc(x);
        const v = await app.ui.dialog({
            title: `⏳ 在追的事：${this.name(card)}`,
            html: `<p class="pm-hint" style="margin-top:0;">在等別人的事不算逾期、不佔今天的位置；到追蹤日會自動跳到候選上面，提醒你去催。</p>
                <div class="qa-fields">
                    <label>等誰<input value="${esc(f.who)}" placeholder="例如：化學署承辦" oninput="app.today._waitForm.who=this.value"></label>
                    <label style="flex:2;">等什麼<input value="${esc(f.what)}" placeholder="例如：回覆會議時間" oninput="app.today._waitForm.what=this.value"></label>
                    <label>哪天追<input type="date" value="${esc(f.fu)}" oninput="app.today._waitForm.fu=this.value"></label>
                </div>`,
            buttons: [{ label: '取消', value: null }, ...(was ? [{ label: '不用等了', value: 'clear' }] : []), { label: '儲存', value: 'ok', primary: true }]
        });
        if (v === 'clear') {
            card.waitingWho = ''; card.waitingWhat = ''; card.followUpDate = '';
            if (Number(card.status) === 3) card.status = 1;
        } else if (v === 'ok') {
            card.waitingWho = f.who.trim(); card.waitingWhat = f.what.trim(); card.followUpDate = f.fu || '';
            if (Number(card.status) !== 2) card.status = 3;
        } else return;
        app.saveToLocal();
        this.render();
        app.ui.toast(v === 'clear' ? '已移出「在追的事」' : `已放到「在追的事」${card.followUpDate ? `，${card.followUpDate.slice(5).replace('-', '/')} 提醒你追` : ''}`);
    },

    candidatesHtml(allIn) {
        let all = allIn;
        const esc = x => this.esc(x);
        if (this.ui.search.trim()) return all.map(r => this.candidateRow(r)).join('');
        // 在等別人的另外一區（今天要不要催）；其餘照舊
        const waiting = all.filter(r => r.why.some(x => x.k === 'wait'));
        all = all.filter(r => !r.why.some(x => x.k === 'wait'));
        const waitHtml = waiting.length ? `<div class="td-group td-waiting">
                <div class="td-group-head"><button type="button" class="td-group-name" onclick="app.today.toggleGroup('__waitOpen__')">${this.ui.collapsed.__waitOpen__ ? '▾' : '▸'} ⏳ 在追的事 <span class="ls-count">${waiting.length}</span></button><span class="td-meta">在等別人，不算逾期；到追蹤日會自動跳到上面</span></div>
                ${this.ui.collapsed.__waitOpen__ ? waiting.map(r => this.candidateRow(r)).join('') : ''}
            </div>` : '';
        // 有理由的（快到期、進行中、有待辦…）排前面；其他未完成的卡收在最下面，不會漏掉
        const cands = all.filter(r => r.why.length), quiet = all.filter(r => !r.why.length);
        const quietHtml = quiet.length ? `<details class="td-quiet" ${this.ui.showQuiet !== false ? 'open' : ''} ontoggle="app.today.ui.showQuiet=this.open">
                <summary>其他未完成的卡 <span class="ls-count">${quiet.length}</span> <span class="td-meta">沒有截止日、還沒開始、沒有待辦</span></summary>
                ${quiet.map(r => this.candidateRow(r)).join('')}
            </details>` : '';
        if (this.groupBy() === 'urgency') return waitHtml + cands.map(r => this.candidateRow(r)).join('') + quietHtml;
        // 依專案：每個專案列出它所有未完成的卡（有理由的在前），不另外收起來
        const groups = new Map();
        all.forEach(r => { const k = String(r.card.project || '').trim() || '雜項'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
        const top = rs => Math.max(0, ...rs.flatMap(r => r.why.map(x => x.w)));
        return [...groups.entries()].sort((a, b) => top(b[1]) - top(a[1]) || a[0].localeCompare(b[0], 'zh-Hant')).map(([k, rs]) => {
            const closed = !!this.ui.collapsed[k];
            return `<div class="td-group">
                <div class="td-group-head">
                    <button type="button" class="td-group-name" onclick="app.today.toggleGroup(${esc(JSON.stringify(k))})">${closed ? '▸' : '▾'} ${esc(k)} <span class="ls-count">${rs.length}</span></button>
                    <button type="button" class="td-group-skip" onclick="app.today.skipGroup(${esc(JSON.stringify(rs.map(r => r.card.id)))})" title="這個專案今天都不做">整組不做</button>
                </div>
                ${closed ? '' : rs.map(r => this.candidateRow(r, false)).join('')}
            </div>`;
        }).join('').replace(/^/, waitHtml);
    },

    item(r, kind) {
        const esc = x => this.esc(x);
        const card = r.card;
        const fixed = kind === 'fixed';
        const p = fixed ? null : r.p;
        const done = fixed ? this.fixedDoneOn(card) : this.isDone(card);
        const worked = !fixed && this.date() === this.todayStr() ? this.minutesOn(card, this.todayStr()) : 0;
        const t = this.typeOf(card);
        const est = fixed ? card.fixed.est : p.est;
        const slot = fixed ? card.fixed.slot : p.slot;
        const flags = [];
        if (!fixed && !done) {
            if (slot === 'low' && this.DEEP.includes(t)) flags.push(`${this.TYPES[t].name}型需要專心，放在「${this.slots().low.name}」容易卡住`);
            const end = card.isMemo ? '' : this.W().plannedEnd(card);
            if (p.pri === 'opt' && end && end <= this.addDays(this.date(), 1)) flags.push(`${end.slice(5).replace('-', '/')} 截止，考慮改成必做`);
        }
        return `<div class="td-item ${kind} ${done ? 'done' : ''}" draggable="${fixed ? 'false' : 'true'}" ondragstart="app.today.dragStart(event,'${card.id}')" data-id="${card.id}">
            ${fixed ? `<button type="button" class="td-fixed-done ${done ? 'on' : ''}" onclick="app.today.toggleDone('${card.id}')" title="固定項每天打一次">${done ? '✓ 今天做了' : '今天做了？'}</button>` : `<input type="checkbox" ${done ? 'checked' : ''} onchange="app.today.toggleDone('${card.id}')" title="這件事做完了（整張卡標成完成）">`}
            <div class="td-item-body">
                <button type="button" class="td-item-title" onclick="app.today.focus('${card.id}')" title="進入專注模式（計時、筆記）">${t ? this.TYPES[t].icon + ' ' : ''}${esc(this.name(card))}</button>
                ${flags.map(f => `<div class="td-flag">⚠ ${esc(f)}</div>`).join('')}
                <div class="td-item-meta">
                    ${fixed ? '' : `<button type="button" class="td-tag ${kind} td-tag-btn" onclick="app.today.classify('${card.id}','${p.pri === 'must' ? 'opt' : 'must'}')" title="點一下切換必做／備選">${p.pri === 'must' ? '必做' : '備選'}</button>`}${fixed ? '<span class="td-tag fixed">固定</span>' : ''}
                    ${!fixed && !t ? this.typeSelect(card) : ''}
                    ${this.estSelect(card.id, est)}${worked ? `<span class="td-worked" title="今天已記的工時">⏱ 今天 ${worked} 分</span>` : ''}
                    ${this.slotSelect(card.id, slot)}
                    ${fixed ? `<span class="td-meta">${esc(this.ruleText(card.fixed))}</span><button type="button" class="td-x" onclick="app.today.editFixed('${card.id}')" title="修改週期、時段、分鐘">⚙</button><button type="button" class="td-x" onclick="app.today.removeFixed('${card.id}')" title="取消固定">×</button>` : `<button type="button" class="td-x" onclick="app.today.unplan('${card.id}')" title="移回候選">↩</button>`}
                    <button type="button" class="td-del" onclick="app.actions.deleteCard('${card.id}')" title="刪除這張卡（可在「資料 → 最近刪除」救回）">🗑</button>
                </div>
            </div>
        </div>`;
    },

    board(S) {
        const esc = x => this.esc(x);
        const slots = this.slots();
        const rank = r => (this.isDone(r.card) ? 10 : 0) + (r.p.pri === 'must' ? 0 : 1);
        const col = (k) => {
            const fixed = S.fixed.filter(r => r.card.fixed.slot === k);
            const mtgs = (S.meetings || []).filter(m => m.slot === k);
            const items = S.planned.filter(r => r.p.slot === k).sort((a, b) => rank(a) - rank(b));
            const cap = this.cap(k), used = S.bySlot[k];
            return `<div class="td-col" data-slot="${k}" ondragover="app.today.dragOver(event,this)" ondragleave="this.classList.remove('over')" ondrop="app.today.drop(event,'${k}',this)">
                <div class="td-col-head ${cap && used > cap ? 'over-cap' : ''}">
                    <b>${esc(slots[k].name)}</b> <span class="td-time">${esc(slots[k].from)}–${esc(slots[k].to)}</span>
                    <span class="td-cap">${used}/${cap} 分</span>
                </div>
                ${mtgs.map(m => `<div class="td-item meeting"><span>📅</span><div class="td-item-body"><b class="td-mtg-title">${esc(m.title)}</b><div class="td-item-meta"><span class="td-tag mtg">會議</span><span class="td-meta">${m.min} 分</span><button type="button" class="td-x" onclick="app.today.removeMeeting('${m.id}')" title="移除">×</button></div></div></div>`).join('')}
                ${fixed.map(r => this.item(r, 'fixed')).join('')}${items.map(r => this.item(r, r.p.pri)).join('')}
                ${!fixed.length && !items.length && !mtgs.length ? '<div class="td-empty">拖到這裡，或用下拉選時段</div>' : ''}
            </div>`;
        };
        const unslotted = S.planned.filter(r => !this.SLOT_ORDER.includes(r.p.slot)).sort((a, b) => rank(a) - rank(b));
        const fixedNo = S.fixed.filter(r => !this.SLOT_ORDER.includes(r.card.fixed.slot));
        return `<div class="td-board">${this.SLOT_ORDER.map(col).join('')}</div>
            ${unslotted.length || fixedNo.length ? `<div class="td-col td-tray" data-slot="" ondragover="app.today.dragOver(event,this)" ondragleave="this.classList.remove('over')" ondrop="app.today.drop(event,'',this)">
                <div class="td-col-head"><b>還沒放時段</b><span class="td-cap">設好類型會自動放；也可以拖或用下拉</span></div>
                ${fixedNo.map(r => this.item(r, 'fixed')).join('')}${unslotted.map(r => this.item(r, r.p.pri)).join('')}</div>` : ''}`;
    },

    render() {
        const target = document.getElementById('today-render-target');
        if (!target) return;
        const esc = x => this.esc(x);
        const date = this.date(), S = this.summary(date), warns = this.warnings(date);
        const allCands = this.candidates(date), skipped = this.skippedRows(date);
        const cands = this.ui.search.trim() ? allCands : allCands.filter(r => r.why.length);
        const h = m => Math.round(m / 6) / 10;
        const keepSearch = document.activeElement?.id === 'td-search' ? document.activeElement.selectionStart : null;
        const keepDump = document.activeElement?.id === 'td-dump';
        const mtab = this.ui.mtab === 'board' ? 'board' : 'classify';
        const tip = { total: S.total > this.budget(date) ? '超過每天可專心的時間，考慮把一件必做改成備選或明天' : '必做＋備選＋固定項的預估合計', must: `必做建議不超過 ${this.LIMIT_MUST} 件`, opt: `備選建議不超過 ${this.LIMIT_OPT} 件` };
        const slots = this.slots();
        target.innerHTML = `<div class="td-wrap">
            ${this.backupBannerHtml()}
            <div class="td-top">
                <div class="td-mode">
                    <button type="button" class="${this.ui.mode !== 'review' ? 'on' : ''}" onclick="app.today.ui.mode='plan'; app.today.render()">排計畫</button>
                    <button type="button" class="${this.ui.mode === 'review' ? 'on' : ''} ${new Date().getHours() >= 16 && !app.daylog.get(this.todayStr()).closedAt ? 'hint' : ''}" onclick="app.today.ui.mode='review'; app.today.render()" title="計畫 vs 實際">🌆 收工帳單</button>
                </div>
                <div class="td-days" ${this.ui.mode === 'review' ? 'style="display:none"' : ''}>
                    <button type="button" class="${this.which() === 'today' ? 'active' : ''}" onclick="app.today.ui.which='today'; app.today.render()">今天 ${esc(this.dateLabel(this.todayStr()))}</button>
                    <button type="button" class="${this.which() === 'tomorrow' ? 'active' : ''}" onclick="app.today.ui.which='tomorrow'; app.today.render()">明天 ${esc(this.dateLabel(this.addDays(this.todayStr(), 1)))}</button>
                </div>
                <div class="td-sum">
                    <span class="${S.must.length > this.LIMIT_MUST ? 'bad' : ''}" title="${esc(tip.must)}">必做 <b>${S.must.length}</b>/${this.LIMIT_MUST}</span>
                    <span class="${S.opt.length > this.LIMIT_OPT ? 'bad' : ''}" title="${esc(tip.opt)}">備選 <b>${S.opt.length}</b>/${this.LIMIT_OPT}</span>
                    <button type="button" class="td-budget ${S.total > this.budget(date) ? 'bad' : ''}" title="${esc(tip.total)}（點一下改這天可專心的時數）" onclick="app.today.setDayBudget()">預估 <b>${h(S.total)}</b>/${h(this.budget(date))} 小時${app.daylog.get(date).budget ? ' ✎' : ''}</button>
                    ${S.count ? `<span>完成 <b>${S.done}</b>/${S.count}</span>` : ''}
                </div>
                <div class="td-ai">
                <button type="button" class="primary" onclick="app.today.aiSend()">🤖 請 AI 幫我分類／排時段</button>
                <button type="button" onclick="app.today.aiPaste()">📥 貼上 AI 的結果</button>
                <button type="button" onclick="app.today.interrupt()" title="臨時插進來的事，快速記一筆">⚡ 被打斷</button>
                <button type="button" onclick="app.today.ui.showSettings=!app.today.ui.showSettings; app.today.render()" title="時段設定">⚙</button>
                    <button type="button" class="td-cloud-m" onclick="app.cloud.save()" title="排好後存到雲端，電腦才看得到">☁️ 存雲端</button>
                </div>
            </div>
            ${this.ui.showSettings ? `<div class="td-settings">
                ${this.SLOT_ORDER.map(k => `<div class="td-set-row"><input value="${esc(slots[k].name)}" onchange="app.today.setSlotPref('${k}','name',this.value)"><input type="time" value="${esc(slots[k].from)}" onchange="app.today.setSlotPref('${k}','from',this.value)"><span>–</span><input type="time" value="${esc(slots[k].to)}" onchange="app.today.setSlotPref('${k}','to',this.value)"><span class="td-meta">${this.cap(k)} 分</span></div>`).join('')}
                <div class="td-set-row"><span>每天可專心的時間</span><input type="number" min="1" max="12" step="0.5" value="${h(this.defaultBudget())}" onchange="app.today.setBudget(this.value)"><span>小時（書上建議 ≤ 5）</span></div>
                <div class="td-meta">預設是中間型的節奏。這些設定會跟著雲端同步。</div>
                ${app.aiAboutField()}
            </div>` : ''}
            <div class="td-mtabs"><button type="button" class="${mtab === 'classify' ? 'on' : ''}" onclick="app.today.ui.mtab='classify'; app.today.render()">① 分類 <b>${cands.length}</b></button><button type="button" class="${mtab === 'board' ? 'on' : ''}" onclick="app.today.ui.mtab='board'; app.today.render()">② 排程板 <b>${S.count}</b></button></div>

            <div class="td-main" data-mtab="${mtab}">
            <section class="td-sec td-left">
                <h4>① 分類 <span class="td-meta">未完成 ${allCands.length} 張都在這裡，最重要的先點。</span>
                    <span class="td-groupby"><button type="button" class="${this.groupBy() === 'project' ? 'on' : ''}" onclick="app.today.setGroupBy('project')">依專案</button><button type="button" class="${this.groupBy() === 'urgency' ? 'on' : ''}" onclick="app.today.setGroupBy('urgency')">依急迫</button></span></h4>
                <div class="td-dump">
                    <textarea id="td-dump" rows="1" placeholder="＋ 腦中想到什麼先打下來（Enter 加入；貼多行＝多張卡）" onkeydown="if(event.key==='Enter' && !event.shiftKey && !event.isComposing){ event.preventDefault(); app.today.brainDump(); }">${esc(this.ui.dump || '')}</textarea>
                </div>
                ${this.blankCount() ? `<div class="td-blank">另有 ${this.blankCount()} 張空白卡（沒有標題、內容、工時），沒有列在這裡。<button type="button" onclick="app.today.clearBlanks()">清掉</button></div>` : ''}
                <input type="search" id="td-search" class="td-search" placeholder="從所有卡片找…" value="${esc(this.ui.search)}" oninput="app.today.ui.search=this.value; clearTimeout(app.today._t); app.today._t=setTimeout(()=>app.today.render(),200)">
                ${allCands.length ? this.candidatesHtml(allCands) : `<div class="data-empty">${this.ui.search ? '找不到符合的卡片。' : '候選都分好了。想加別的卡，用上面的搜尋。'}</div>`}
                ${skipped.length ? `<details class="td-skipped" ${this.ui.showSkipped ? 'open' : ''} ontoggle="app.today.ui.showSkipped=this.open"><summary>今天不做 ${skipped.length}</summary>${skipped.map(({ card }) => `<div class="td-skip-row"><span>${esc(this.name(card))}</span><button type="button" onclick="app.today.unplan('${card.id}')">↩ 放回候選</button></div>`).join('')}</details>` : ''}
                <div class="td-meta" style="margin-top:6px;">兩分鐘內能做完的事不用記，直接做。</div>
            </section>

            <section class="td-sec td-right">
                <h4>② 排程板 <span class="td-meta">依類型自動放進時段，拖動或用下拉調整。點標題進入專注。</span></h4>
                <div class="td-legend">☐ 勾選＝這件事做完了（整張卡完成，哪裡勾都一樣）。只做了一部分不用勾：計時會記下今天做了多久，沒做完的明天會自動回到候選。</div>
                ${this.board(S)}
                <button type="button" class="td-add-fixed" onclick="app.today.addMeeting()">＋ 會議／外出（只有這天）</button>
                <button type="button" class="td-add-fixed" onclick="app.today.addFixed()">＋ 固定項（晨會、週會、月報…）</button>
            </section>
            </div>
        </div>`;
        const dump = document.getElementById('td-dump');
        if (this.ui.mode === 'review') {
            target.querySelector('.td-mtabs')?.remove();
            const main = target.querySelector('.td-main');
            if (main) main.outerHTML = this.reviewHtml();
            target.querySelector('.td-sum')?.remove();
            const ai = target.querySelector('.td-ai');
            if (ai) ai.innerHTML = /week/.test(this.ui.reviewDay || '') ? `<button type="button" class="primary" onclick="app.today.weekAiSend()">🤖 AI 週回顧</button>` : `<button type="button" class="primary" onclick="app.today.aiCombinedSend()" title="把今天的帳單和明天的候選一起交給 AI">🤖 AI 檢討今天＋排明天</button><button type="button" onclick="app.today.aiPaste()">📥 貼上 AI 的結果</button>`;
            return;
        }
        if (dump) { const fit = () => { dump.style.height = 'auto'; dump.style.height = Math.min(120, dump.scrollHeight + 2) + 'px'; }; dump.oninput = () => { this.ui.dump = dump.value; fit(); }; fit(); if (keepDump) { dump.focus(); } }
        if (keepSearch !== null) { const el = document.getElementById('td-search'); el.focus(); el.selectionStart = el.selectionEnd = keepSearch; }
    },

    // 拖曳換時段（電腦）
    dragStart(e, id) { this._drag = id; try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; } catch (_) {} },
    dragOver(e, el) { if (!this._drag) return; e.preventDefault(); el.classList.add('over'); },
    // 候選卡直接拖進時段＝排進今天（預設必做，必做滿 4 件就當備選），再點標籤可互換
    drop(e, slot, el) {
        e.preventDefault(); el.classList.remove('over');
        const id = this._drag; this._drag = null;
        if (!id) return;
        const card = this.W().getCard(id), date = this.date();
        if (card && !card.fixed && !['must', 'opt'].includes(this.planOf(card, date)?.pri)) {
            const pri = this.summary(date).must.length >= this.LIMIT_MUST ? 'opt' : 'must';
            this.setPlan(card, date, { pri, slot: this.SLOT_ORDER.includes(slot) ? slot : null, est: this.planOf(card, date)?.est || this.defaultEst(card), done: false });
            this.save(id);
            app.ui.toast(`「${this.name(card)}」排進${slot ? `「${this.slots()[slot].name}」` : '今天'}（${pri === 'must' ? '必做' : '備選'}）`);
            return;
        }
        this.setSlot(id, slot);
    },

    // ---------- 🌆 收工帳單：計畫 vs 實際 ----------
    reviewDate() { return this.ui.reviewDay === 'yesterday' ? this.addDays(this.todayStr(), -1) : this.todayStr(); },
    reviewData(date = this.reviewDate()) {
        const S = this.summary(date);
        const items = S.planned.map(r => ({
            card: r.card, pri: r.p.pri, slot: r.p.slot, type: this.typeOf(r.card),
            est: Number(r.p.est) || 0, act: this.minutesOn(r.card, date), done: this.isDone(r.card)
        })).sort((a, b) => (a.pri === 'must' ? 0 : 1) - (b.pri === 'must' ? 0 : 1));
        const fixed = S.fixed.map(r => ({ card: r.card, est: Number(r.card.fixed.est) || 0, act: this.minutesOn(r.card, date), done: this.fixedDoneOn(r.card, date) }));
        const meetings = S.meetings || [];
        const plannedIds = new Set([...items, ...fixed].map(x => x.card.id));
        const unplanned = this.W().allCards().filter(({ card }) => !plannedIds.has(card.id) && this.minutesOn(card, date) > 0)
            .map(({ card }) => ({ card, act: this.minutesOn(card, date), type: this.typeOf(card) })).sort((a, b) => b.act - a.act);
        const sum = (list, k) => list.reduce((s, x) => s + (Number(x[k]) || 0), 0);
        const estTotal = sum(items, 'est') + sum(fixed, 'est');
        const actPlanned = sum(items, 'act') + sum(fixed, 'act');
        const actUnplanned = sum(unplanned, 'act');
        return { date, items, fixed, meetings, unplanned, estTotal, actPlanned, actUnplanned, actTotal: actPlanned + actUnplanned,
            mustDone: items.filter(x => x.pri === 'must' && x.done).length, mustN: items.filter(x => x.pri === 'must').length,
            doneN: items.filter(x => x.done).length + fixed.filter(x => x.done).length, n: items.length + fixed.length };
    },
    // 預估準確度：近 30 天收工紀錄＋今天，依類型算「實際 ÷ 預估」
    accuracy(days = 30) {
        const from = this.addDays(this.todayStr(), -days), today = this.todayStr();
        const rows = [];
        Object.entries(app.daylog.all()).forEach(([d, v]) => { if (d >= from && d < today && Array.isArray(v.items)) rows.push(...v.items); });
        this.reviewData(today).items.forEach(x => rows.push({ t: x.type, e: x.est, a: x.act }));
        const by = {};
        rows.filter(x => x.e > 0 && x.a > 0).forEach(x => { const k = this.TYPES[x.t] ? x.t : 'none'; by[k] = by[k] || { e: 0, a: 0, n: 0 }; by[k].e += x.e; by[k].a += x.a; by[k].n += 1; });
        const all = Object.values(by).reduce((s, x) => ({ e: s.e + x.e, a: s.a + x.a, n: s.n + x.n }), { e: 0, a: 0, n: 0 });
        return { by, all };
    },
    ratioText(x) { if (!x || !x.e || x.n < 1) return ''; const r = x.a / x.e; return r >= 1 ? `實際約為預估的 ${Math.round(r * 10) / 10} 倍` : `實際約為預估的 ${Math.round(r * 100)}%`; },
    accuracyLines() {
        const A = this.accuracy();
        const lines = [...this.TYPE_ORDER, 'none'].filter(k => A.by[k]?.n >= 2).map(k => `${k === 'none' ? '未設類型' : this.TYPES[k].name + '型'}：${this.ratioText(A.by[k])}（${A.by[k].n} 件）`);
        return { lines, all: A.all };
    },
    setEnergy(v) { app.daylog.set(this.reviewDate(), { energy: v }); this.render(); },
    setNote(v) { app.daylog.set(this.reviewDate(), { note: String(v || '') }); },
    carry(cardId) {
        const card = this.W().getCard(cardId);
        const d = this.reviewDate(), next = this.addDays(d, 1);
        const p = this.planOf(card, d);
        if (!card || !p) return;
        if (!this.planOf(card, next)) this.setPlan(card, next, { pri: p.pri, slot: p.slot, est: p.est });
        app.saveToLocal(); this.render();
    },
    carryAll() {
        const R = this.reviewData();
        const left = R.items.filter(x => !x.done && !this.planOf(x.card, this.addDays(R.date, 1)));
        left.forEach(x => { const next = this.addDays(R.date, 1); if (!this.planOf(x.card, next)) this.setPlan(x.card, next, { pri: x.pri, slot: x.slot, est: x.est }); });
        app.saveToLocal(); this.render();
        app.ui.toast(`${left.length} 件移到明天`);
    },
    closeDay() {
        const R = this.reviewData();
        app.daylog.set(R.date, {
            closedAt: Date.now(),
            items: R.items.map(x => ({ t: x.type, e: x.est, a: x.act, d: x.done ? 1 : 0, p: x.pri })),
            est: R.estTotal, act: R.actTotal, unplanned: R.actUnplanned, done: R.doneN, n: R.n
        });
        this.ui.mode = 'plan';
        if (R.date === this.todayStr()) this.ui.which = 'tomorrow';
        this.render();
        app.ui.toast('收工！接著排明天（不排也可以，明早再排）', 'info', 4500);
    },
    aiReviewPrompt() {
        const R = this.reviewData(), slots = this.slots(), log = app.daylog.get(R.date);
        const h = m => `${m} 分`;
        const acc = this.accuracyLines();
        const pri = { must: '必做', opt: '備選' };
        return [
            `請當我的時間管理教練，幫我看 ${this.dateLabel(R.date)} 的收工帳單（方法出自《幫你的時間記帳》：每天比對計畫和實際，找出時間去了哪裡、估得準不準）。`,
            '',
            '【計畫 vs 實際】',
            ...(R.items.length ? R.items.map(x => `- ${pri[x.pri]}｜${x.type ? this.TYPES[x.type].name : '未設類型'}｜${this.name(x.card)}｜${x.slot ? slots[x.slot].name : '未排時段'}｜預估 ${h(x.est)}｜實際 ${h(x.act)}｜${x.done ? '完成' : '沒完成'}`) : ['（今天沒有排計畫）']),
            ...R.fixed.map(x => `- 固定｜${this.name(x.card)}｜預估 ${h(x.est)}｜${x.done ? '有做' : '沒做'}`),
            ...(R.meetings || []).map(m => `- 會議／外出｜${m.title}｜${m.min} 分`),
            '',
            '【計畫外的時間】',
            ...(R.unplanned.length ? R.unplanned.map(x => `- ${this.name(x.card)}｜${h(x.act)}`) : ['（沒有）']),
            '',
            `【合計】預估 ${h(R.estTotal)}；實際 ${h(R.actTotal)}（其中計畫外 ${h(R.actUnplanned)}）；必做完成 ${R.mustDone}/${R.mustN}。`,
            `【我的時段】我是中間型：${this.SLOT_ORDER.map(k => `${slots[k].name} ${slots[k].from}–${slots[k].to}`).join('、')}。${log.energy ? `今天精神最好的是：${log.energy === 'none' ? '都普通' : slots[log.energy]?.name}。` : ''}`,
            acc.lines.length ? `【近 30 天預估偏差】${acc.lines.join('；')}` : '',
            log.note ? `【我自己的感想】${log.note}` : '',
            '',
            '【請你這樣做】',
            '1. 有看不懂或需要知道原因的地方（例如某件為什麼沒做完、計畫外的事是什麼），先問我，一次最多 2 個問題。',
            '2. 討論完，用 3～5 句告訴我：哪裡估錯了、時間被什麼吃掉、哪個時段用得好或不好。',
            '3. 給我明天 1～2 個具體的調整建議（例如某類工作預估要乘以多少、某件事該放哪個時段）。不要給一般性的時間管理大道理。'
        ].filter(x => x !== '').join('\n');
    },
    // 收工＋排明天一次交給 AI：先看今天的帳單，再排明天。貼回來時排進明天、反思填進今天。
    aiCombinedPrompt() {
        const R = this.reviewData(), tomorrow = this.addDays(R.date, 1);
        const review = this.aiReviewPrompt().split('\n【請你這樣做】')[0].split('\n').slice(1);
        const plan = this.aiPrompt(tomorrow, R.date).split('\n').slice(1);
        const cut = plan.indexOf('【請你這樣做】');
        return [
            `請當我的時間管理教練，分兩步：先看我 ${this.dateLabel(R.date)} 的收工帳單，再幫我排 ${this.dateLabel(tomorrow)} 的計畫。`,
            '',
            '======== 第一步：今天的收工帳單 ========',
            ...review,
            '',
            `======== 第二步：排 ${this.dateLabel(tomorrow)} ========`,
            ...plan.slice(0, cut),
            '【請你這樣做】',
            '1. 兩部分有看不懂、需要知道原因或判斷不了的地方（某件為什麼沒做完、類型或重要性），先問我，一次最多 3 個問題，等我回答再繼續。不要自己猜。',
            '2. 用 3～5 句回饋今天：哪裡估錯了、時間被什麼吃掉、哪個時段用得好或不好；明天的排法要用上這些教訓。',
            '3. 把最後結果放在一個程式碼區塊裡：',
            '第一行：反思：（一句話總結今天，用我的口吻）',
            '之後每件一行：[編號] 必做|備選|不做 類型 時段 分鐘',
            '例如：[3] 必做 分析 上午 60',
            `類型只能是：分析、研究、創造、溝通、雜物；時段只能是：上午、低谷、下午（分別對應 ${this.slots().am.name}、${this.slots().low.name}、${this.slots().pm.name}）。`,
            '4. 程式碼區塊後面，用 1～2 句說明明天這樣排的理由與要注意的地方。'
        ].join('\n');
    },
    async aiCombinedSend() {
        const text = app.aiText(this.aiCombinedPrompt());
        if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
            try { await navigator.share({ text }); return; } catch (err) { if (err?.name === 'AbortError') return; }
        }
        this.W().copyText(text, '已複製，貼到 AI。討論完把結果貼回「📥 貼上 AI 的結果」，會排進明天、反思填進今天');
    },

    async aiReviewSend() {
        const text = app.aiText(this.aiReviewPrompt());
        if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
            try { await navigator.share({ text }); return; } catch (err) { if (err?.name === 'AbortError') return; }
        }
        this.W().copyText(text, '已複製，貼到 AI。回饋可以貼回「今天的反思」留著');
    },
    reviewHtml() {
        if (this.ui.reviewDay === 'week' || this.ui.reviewDay === 'lastweek') return this.weekHtml();
        const esc = x => this.esc(x);
        const R = this.reviewData(), slots = this.slots(), log = app.daylog.get(R.date);
        const fm = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
        const diff = (e, a) => { if (!e || !a) return ''; const r = a / e; const cls = r > 1.3 ? 'over' : (r < 0.7 ? 'under' : 'ok'); return `<span class="rv-diff ${cls}">${r >= 1 ? '+' : ''}${Math.round((r - 1) * 100)}%</span>`; };
        const pri = { must: '必做', opt: '備選' };
        const acc = this.accuracyLines();
        const tomorrow = this.addDays(R.date, 1);
        const left = R.items.filter(x => !x.done && !this.planOf(x.card, tomorrow));
        const row = x => `<tr class="${x.done ? 'done' : ''}">
                <td>${x.done ? '✅' : '⬜'}</td>
                <td><span class="td-tag ${x.pri}">${pri[x.pri]}</span></td>
                <td class="rv-title">${x.type ? this.TYPES[x.type].icon + ' ' : ''}${esc(this.name(x.card))}<div class="td-meta">${x.slot ? esc(slots[x.slot].name) : '未排時段'}</div></td>
                <td>${fm(x.est)}</td><td><b>${fm(x.act)}</b> ${diff(x.est, x.act)}</td>
                <td>${x.done ? '' : (this.planOf(x.card, tomorrow) ? '<span class="td-meta">已排明天</span>' : `<button type="button" class="rv-btn" onclick="app.today.carry('${x.card.id}')">移到明天</button>`)}</td>
            </tr>`;
        const energy = [['am', slots.am.name], ['low', slots.low.name], ['pm', slots.pm.name], ['none', '都普通']];
        return `<div class="rv-wrap">
            <div class="rv-head">
                <div class="td-days">
                    <button type="button" class="${this.ui.reviewDay !== 'yesterday' ? 'active' : ''}" onclick="app.today.ui.reviewDay='today'; app.today.render()">今天 ${esc(this.dateLabel(this.todayStr()))}</button>
                    <button type="button" class="${this.ui.reviewDay === 'yesterday' ? 'active' : ''}" onclick="app.today.ui.reviewDay='yesterday'; app.today.render()">昨天</button>
                    <button type="button" onclick="app.today.ui.reviewDay='week'; app.today.render()" title="週五下午或週一早上花 10 分鐘">📊 週回顧</button>
                </div>
                ${log.closedAt ? `<span class="td-meta">已收工 ${esc(app.ui.fmtTime(log.closedAt))}</span>` : ''}
            </div>
            <div class="rv-cards">
                <div class="rv-stat"><div class="rv-num">${R.doneN}/${R.n}</div><div>計畫完成</div><div class="td-meta">必做 ${R.mustDone}/${R.mustN}</div></div>
                <div class="rv-stat"><div class="rv-num">${fm(R.estTotal)} → ${fm(R.actPlanned)}</div><div>計畫的預估 → 實際</div><div class="td-meta">${(() => { const t = R.items.filter(x => x.est && x.act); const e = t.reduce((a, x) => a + x.est, 0), a = t.reduce((b, x) => b + x.act, 0); return e && a ? `有計時的 ${t.length} 件：${this.ratioText({ e, a, n: 1 })}` : '還沒有計時紀錄可以比對'; })()}</div></div>
                <div class="rv-stat ${R.actUnplanned > R.actPlanned ? 'warn' : ''}"><div class="rv-num">${fm(R.actUnplanned)}</div><div>計畫外</div><div class="td-meta">${R.actTotal ? `佔今天記錄的 ${Math.round(R.actUnplanned / R.actTotal * 100)}%` : '今天還沒有計時紀錄'}</div></div>
            </div>
            <section class="td-sec">
                <h4>計畫 vs 實際 ${left.length ? `<button type="button" class="rv-btn" style="float:right;" onclick="app.today.carryAll()">沒做完的 ${left.length} 件全部移到明天</button>` : ''}</h4>
                ${R.items.length || R.fixed.length || (R.meetings || []).length ? `<table class="rv-table"><thead><tr><th></th><th>分類</th><th>事情</th><th>預估</th><th>實際</th><th></th></tr></thead><tbody>
                    ${R.items.map(row).join('')}
                    ${(R.meetings || []).map(m => `<tr><td>📅</td><td><span class="td-tag mtg">會議</span></td><td class="rv-title">${esc(m.title)}</td><td>${fm(m.min)}</td><td>—</td><td></td></tr>`).join('')}
                    ${R.fixed.map(x => `<tr class="${x.done ? 'done' : ''}"><td>${x.done ? '✅' : '⬜'}</td><td><span class="td-tag fixed">固定</span></td><td class="rv-title">${esc(this.name(x.card))}</td><td>${fm(x.est)}</td><td>${x.act ? fm(x.act) : '—'}</td><td></td></tr>`).join('')}
                </tbody></table>` : '<div class="data-empty">這天沒有排計畫。明天試著排 2～3 件必做就好。</div>'}
                <div class="td-meta" style="margin-top:6px;">實際＝這天記到這張卡的工時（計時或補登）。沒計時的事會顯示 0m。</div>
            </section>
            <section class="td-sec">
                <h4>計畫外的時間 <span class="td-meta">這天有記工時、但不在計畫裡</span></h4>
                ${R.unplanned.length ? R.unplanned.map(x => `<div class="rv-un"><span>${x.type ? this.TYPES[x.type].icon + ' ' : ''}${esc(this.name(x.card))}</span><b>${fm(x.act)}</b></div>`).join('') : '<div class="td-meta">沒有。</div>'}
            </section>
            <section class="td-sec">
                <h4>今天哪個時段最有精神？</h4>
                <div class="rv-energy">${energy.map(([k, l]) => `<button type="button" class="${log.energy === k ? 'on' : ''}" onclick="app.today.setEnergy('${k}')">${esc(l)}</button>`).join('')}</div>
                <h4 style="margin-top:14px;">今天的反思 <span class="td-meta">一兩句就好，也可以貼 AI 的回饋</span></h4>
                <textarea class="rv-note" placeholder="例如：上午被會議切碎，研究型的事應該放下午後段" onchange="app.today.setNote(this.value)">${esc(log.note || '')}</textarea>
            </section>
            <section class="td-sec">
                <h4>預估準確度 <span class="td-meta">近 30 天，同類型至少 2 件才算</span></h4>
                ${acc.lines.length ? `<ul class="rv-acc">${acc.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '<div class="td-meta">資料還不夠。持續排計畫、計時、收工，大約一週後就看得出來。</div>'}
            </section>
            <div class="rv-actions">
                <button type="button" onclick="app.today.aiReviewSend()">🤖 只檢討今天</button>
                <button type="button" class="primary" onclick="app.today.closeDay()">收工，排明天 →</button>
            </div>
        </div>`;
    },

    // ---------- 📊 週回顧 ----------
    weekRange(which = this.ui.reviewDay) {
        const t = this.W().parseLocalDate(this.todayStr()), dow = t.getDay() || 7;
        const mon = this.addDays(this.todayStr(), 1 - dow - (which === 'lastweek' ? 7 : 0));
        const days = Array.from({ length: 7 }, (_, i) => this.addDays(mon, i));
        return { mon, days, past: days.filter(d => d <= this.todayStr()), key: this.weekKey(mon) };
    },
    weekData(which) {
        const W = this.weekRange(which), set = new Set(W.days);
        const byProj = {}, byType = {}; let total = 0, interrupt = 0;
        this.W().allCards().forEach(({ card }) => {
            const m = this.W().dailyMinutesMap(card);
            let sum = 0; W.days.forEach(d => { sum += m[d] || 0; });
            if (!sum) return;
            sum = Math.round(sum); total += sum;
            const pj = card.fixed ? '固定項' : (String(card.project || '').trim() || '未分專案');
            byProj[pj] = (byProj[pj] || 0) + sum;
            const ty = this.typeOf(card) || 'none'; byType[ty] = (byType[ty] || 0) + sum;
            if (card.title === '臨時插件') interrupt += sum;
        });
        let mustN = 0, mustDone = 0, planN = 0, planDone = 0, unplanned = 0, closed = 0, mtg = 0;
        const energy = {};
        W.past.forEach(d => {
            const R = this.reviewData(d);
            R.items.forEach(x => { planN++; if (x.done) planDone++; if (x.pri === 'must') { mustN++; if (x.done) mustDone++; } });
            unplanned += R.actUnplanned || 0;
            mtg += (R.meetings || []).reduce((a, m) => a + (Number(m.min) || 0), 0);
            const log = app.daylog.get(d); if (log.closedAt) closed++; if (log.energy) energy[log.energy] = (energy[log.energy] || 0) + 1;
        });
        const notes = W.past.map(d => ({ d, t: String(app.daylog.get(d).note || '').trim() })).filter(x => x.t);
        // 擱很久的卡：沒完成、14 天以上沒有工時也沒排進計畫（不藏起來，只是請你決定）
        const cut = this.addDays(this.todayStr(), -14);
        const stale = this.candidates().filter(({ card }) => {
            if (card.fixed) return false;
            const m = this.W().dailyMinutesMap(card);
            if (Object.keys(m).some(d => d >= cut && m[d] > 0)) return false;
            if (Object.keys(card.plans || {}).some(d => d >= cut)) return false;
            const born = Number(String(card.id).match(/\d{12,}/)?.[0]) || 0;
            return !born || born < this.W().parseLocalDate(cut).getTime();
        }).slice(0, 15);
        const nextKey = this.weekKey(this.addDays(W.mon, 7));
        const stars = this.W().allCards().filter(({ card }) => card.weekFocus === W.key || card.weekFocus === nextKey).map(r => r.card);
        return { ...W, byProj, byType, total, interrupt, mustN, mustDone, planN, planDone, unplanned, closed, mtg, energy, notes, stale, nextKey, stars };
    },
    starNext(id) {
        const card = this.W().getCard(id); if (!card) return;
        const k = this.weekRange('week').key, next = this.weekKey(this.addDays(this.weekRange('week').mon, 7));
        card.weekFocus = card.weekFocus === next ? k : next;
        app.saveToLocal(); this.render();
    },
    weekHtml() {
        const esc = x => this.esc(x), D = this.weekData(this.ui.reviewDay);
        const fm = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
        const bars = (obj, label) => { const arr = Object.entries(obj).sort((a, b) => b[1] - a[1]); const max = arr[0]?.[1] || 1;
            return arr.length ? arr.map(([k, v]) => `<div class="wk-bar"><span class="wk-k">${esc(label(k))}</span><span class="wk-track"><i style="width:${Math.round(v / max * 100)}%"></i></span><b>${fm(v)}</b><span class="td-meta">${Math.round(v / D.total * 100)}%</span></div>`).join('') : '<div class="td-meta">這週還沒有工時紀錄。</div>'; };
        const typeName = k => k === 'none' ? '未分類型' : `${this.TYPES[k].icon} ${this.TYPES[k].name}`;
        const slots = this.slots(), en = Object.entries(D.energy).sort((a, b) => b[1] - a[1])[0];
        const nextStarIds = new Set(D.stars.filter(c => c.weekFocus === D.nextKey).map(c => c.id));
        return `<div class="rv-wrap">
            <div class="rv-head">
                <div class="td-days">
                    <button type="button" onclick="app.today.ui.reviewDay='today'; app.today.render()">← 今天</button>
                    <button type="button" class="${this.ui.reviewDay === 'week' ? 'active' : ''}" onclick="app.today.ui.reviewDay='week'; app.today.render()">本週</button>
                    <button type="button" class="${this.ui.reviewDay === 'lastweek' ? 'active' : ''}" onclick="app.today.ui.reviewDay='lastweek'; app.today.render()">上週</button>
                </div>
                <span class="td-meta">${esc(this.dateLabel(D.mon))} – ${esc(this.dateLabel(D.days[6]))}，收工 ${D.closed}/${D.past.filter(d => { const x = this.W().parseLocalDate(d).getDay(); return x >= 1 && x <= 5; }).length} 天</span>
            </div>
            <div class="rv-cards">
                <div class="rv-stat"><div class="rv-num">${D.mustDone}/${D.mustN}</div><div>必做完成</div><div class="td-meta">全部計畫 ${D.planDone}/${D.planN}</div></div>
                <div class="rv-stat"><div class="rv-num">${fm(D.total)}</div><div>記錄的工時</div><div class="td-meta">會議另外 ${fm(D.mtg)}</div></div>
                <div class="rv-stat ${D.unplanned > D.total / 2 ? 'warn' : ''}"><div class="rv-num">${fm(D.unplanned)}</div><div>計畫外</div><div class="td-meta">其中被打斷 ${fm(D.interrupt)}</div></div>
            </div>
            <section class="td-sec"><h4>時間花在哪個專案</h4>${bars(D.byProj, k => k)}</section>
            <section class="td-sec"><h4>時間花在哪種類型</h4>${bars(D.byType, typeName)}
                ${en ? `<div class="td-meta" style="margin-top:6px;">這週最常覺得精神好的是：<b>${esc(en[0] === 'none' ? '都普通' : slots[en[0]]?.name || en[0])}</b>（${en[1]} 天）</div>` : ''}</section>
            <section class="td-sec"><h4>⭐ 下週重點 <span class="td-meta">點星星標成下週重點；下週一會自動排在候選最前面</span></h4>
                ${D.stars.length ? D.stars.map(c => `<div class="rv-un"><span>${nextStarIds.has(c.id) ? '★ 下週' : '☆ 本週'}　${esc(this.name(c))}</span><button type="button" class="rv-btn" onclick="app.today.starNext('${c.id}')">${nextStarIds.has(c.id) ? '改回本週' : '延到下週'}</button></div>`).join('') : '<div class="td-meta">還沒有。可以從下面「擱很久的卡」或今日候選裡挑。</div>'}
            </section>
            <section class="td-sec"><h4>🕸 擱很久的卡 ${D.stale.length} <span class="td-meta">14 天以上沒動、也沒排。不會藏起來，每張決定一下</span></h4>
                ${D.stale.length ? D.stale.map(({ card }) => `<div class="rv-un"><span>${esc(this.name(card))}<span class="td-meta"> · ${esc(card.project || '未分專案')}</span></span><span>
                    <button type="button" class="rv-btn" onclick="app.today.starNext('${card.id}')">⭐ 下週做</button>
                    <button type="button" class="rv-btn" onclick="app.today.completeCard('${card.id}')">✓ 其實做完了</button>
                    <button type="button" class="rv-btn" onclick="app.today.focus('${card.id}')">打開</button></span></div>`).join('') : '<div class="td-meta">沒有，很好。</div>'}
            </section>
            ${D.notes.length ? `<section class="td-sec"><h4>這週的反思</h4><ul class="rv-acc">${D.notes.map(n => `<li><b>${esc(this.dateLabel(n.d))}</b> ${esc(n.t)}</li>`).join('')}</ul></section>` : ''}
            <section class="td-sec"><h4>這週的心得 <span class="td-meta">一兩句，存在週一那天</span></h4>
                <textarea class="rv-note" placeholder="例如：會議比想像多，下週研究型的事放週二、週四上午" onchange="app.daylog.set('${D.mon}', { weekNote: this.value })">${esc(app.daylog.get(D.mon).weekNote || '')}</textarea></section>
        </div>`;
    },
    weekPrompt() {
        const D = this.weekData(this.ui.reviewDay), h = m => Math.round(m / 6) / 10;
        const typeName = k => k === 'none' ? '未分類型' : this.TYPES[k].name;
        return [
            `我在用《幫你的時間記帳》的方法管理時間。這是我 ${D.mon} 那週的紀錄，請幫我做週回顧：`,
            `1. 時間分配和我的重點是否一致？哪裡被吃掉了？`,
            `2. 必做的完成率、計畫外和被打斷的比例，代表什麼？`,
            `3. 「擱很久的卡」每張建議：下週做／其實可以結案／先放著（只是建議，我自己決定）。`,
            `4. 下週最多 3 個重點，和一個要調整的習慣。請簡短、條列。`,
            '',
            `【總覽】必做完成 ${D.mustDone}/${D.mustN}；全部計畫 ${D.planDone}/${D.planN}；記錄工時 ${h(D.total)} 小時；會議 ${h(D.mtg)} 小時；計畫外 ${h(D.unplanned)} 小時（被打斷 ${h(D.interrupt)} 小時）；收工 ${D.closed} 天`,
            '【依專案】', ...Object.entries(D.byProj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}：${h(v)} 小時`),
            '【依類型】', ...Object.entries(D.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${typeName(k)}：${h(v)} 小時`),
            '【本週／下週重點】', ...(D.stars.length ? D.stars.map(c => `- ${this.name(c)}${c.weekFocus === D.nextKey ? '（下週）' : ''}`) : ['（沒有）']),
            '【擱很久的卡】', ...(D.stale.length ? D.stale.map(({ card }) => `- ${this.name(card)}（${card.project || '未分專案'}）`) : ['（沒有）']),
            ...(D.notes.length ? ['【每天的反思】', ...D.notes.map(n => `- ${n.d}：${n.t}`)] : [])
        ].join('\n');
    },
    async weekAiSend() {
        let text = app.aiText(this.weekPrompt());
        if (app.batch?.mask) text = app.batch.mask(text);
        if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
            try { await navigator.share({ text }); return; } catch (err) { if (err?.name === 'AbortError') return; }
        }
        this.W().copyText(text, '已複製週回顧，貼到 AI。心得可以貼回「這週的心得」');
    },

    // ---------- 每月備份提醒（只提醒，不自動） ----------
    backupBannerHtml() {
        let last = 0, snooze = 0, first = 0;
        try {
            last = app.dataCenter.lastExport();
            snooze = Number(localStorage.getItem('whiteboard_backup_snooze')) || 0;
            first = Number(localStorage.getItem('whiteboard_first_seen')) || 0;
            if (!first) { first = Date.now(); localStorage.setItem('whiteboard_first_seen', String(first)); }
        } catch (_) { return ''; }
        const day = 864e5, now = Date.now();
        if (snooze > now) return '';
        const since = last || first;
        if (now - since < 30 * day) return '';
        const d = Math.floor((now - since) / day);
        return `<div class="td-backup">💾 ${last ? `上次匯出完整備份是 ${d} 天前` : '還沒匯出過完整備份'}。雲端和本機快照之外，每月存一份檔案到自己電腦最安心。
            <button type="button" onclick="app.dataCenter.exportJson(); app.today.render()">⬇️ 匯出備份</button>
            <button type="button" class="ghost" onclick="try{localStorage.setItem('whiteboard_backup_snooze', String(Date.now()+7*864e5))}catch(_){}; app.today.render()">一週後再提醒</button></div>`;
    },

    // ---------- 心流裡的今日計畫 ----------
    sandboxHtml() {
        const esc = x => this.esc(x);
        const date = this.todayStr();
        const S = this.summary(date);
        if (!S.count) return `<div class="sb-today empty">📅 今天還沒排計畫 <button type="button" onclick="app.switchView('today')">去排</button></div>`;
        const slots = this.slots();
        const list = [
            ...S.fixed.map(r => ({ card: r.card, slot: r.card.fixed.slot, tag: '固定', done: this.fixedDoneOn(r.card, date), pr: 0 })),
            ...S.planned.map(r => ({ card: r.card, slot: r.p.slot, tag: r.p.pri === 'must' ? '必做' : '備選', done: this.isDone(r.card), pr: r.p.pri === 'must' ? 1 : 2 }))
        ].sort((a, b) => (this.SLOT_ORDER.indexOf(a.slot) + 1 || 9) - (this.SLOT_ORDER.indexOf(b.slot) + 1 || 9) || a.pr - b.pr);
        const sb = app.state.sandbox;
        return `<div class="sb-today">
            <div class="sb-today-head"><b>📅 今日計畫</b><span>${S.done}/${S.count} 完成</span><button type="button" onclick="app.switchView('today')">排程板</button></div>
            ${list.map(x => `<div class="sb-today-row ${x.done ? 'done' : ''} ${sb.activeTaskId === x.card.id ? 'active' : ''}">
                <input type="checkbox" ${x.done ? 'checked' : ''} onchange="app.today.ui.which='today'; app.today.toggleDone('${x.card.id}')" title="${x.tag === '固定' ? '固定項：今天做了' : '這件事做完了（整張卡完成）'}">
                <span class="sb-today-slot">${esc(slots[x.slot]?.name || '未排')}</span>
                <button type="button" onclick="app.sandbox.setActiveTask('${x.card.id}')">${this.typeOf(x.card) ? this.TYPES[this.typeOf(x.card)].icon + ' ' : ''}${esc(this.name(x.card))}</button>
                <span class="td-tag ${x.tag === '必做' ? 'must' : x.tag === '備選' ? 'opt' : 'fixed'}">${x.tag}</span>
            </div>`).join('')}
        </div>`;
    },
    renderSandbox() { const el = document.getElementById('sb-today-plan'); if (el) el.innerHTML = this.sandboxHtml(); },

    // 時間軸卡片上的小標記
    badgeHtml(card) {
        const t = this.typeOf(card);
        const p = this.planOf(card, this.todayStr());
        const tb = t ? `<span class="type-badge" title="任務類型：${this.TYPES[t].name}型">${this.TYPES[t].icon}</span>` : '';
        const pb = p && ['must', 'opt'].includes(p.pri) && !this.isDone(card) ? `<span class="plan-badge ${p.pri}" title="今日計畫">今日・${p.pri === 'must' ? '必做' : '備選'}</span>` : '';
        const fb = card.fixed ? '<span class="plan-badge fixed" title="每天的固定項">固定</span>' : '';
        return tb + pb + fb;
    },

    // ---------- AI：分類＋排時段（會反問） ----------
    AI_KEY: 'whiteboard_today_ai',
    aiPrompt(date = this.date(), reviewDate = null) {
        const W = this.W(), slots = this.slots();
        const S = this.summary(date);
        const list = [...S.planned.map(r => r), ...this.candidates(date)].slice(0, 60);
        const seen = new Set();
        const items = list.filter(r => !seen.has(r.card.id) && seen.add(r.card.id)).slice(0, 40);
        const map = items.map(r => r.card.id);
        try { localStorage.setItem(this.AI_KEY, JSON.stringify({ date, map, reviewDate })); } catch (_) {}
        const line = (r, i) => {
            const c = r.card, p = this.planOf(c, date), t = this.typeOf(c), end = c.isMemo ? '' : W.plannedEnd(c);
            const why = (r.why || this.reasons(c, date)).map(x => x.t).join('、');
            const open = app.sandbox.parseSubtasks(c.content).filter(s => !s.completed).map(s => s.text).slice(0, 4);
            return `[${i + 1}] ${this.name(c)}｜專案：${c.project || '—'}｜${end ? `截止 ${end}` : '沒有截止日'}｜狀態：${W.statusLabel(c.status)}｜類型：${t ? this.TYPES[t].name : '未設定'}${p ? `｜目前排：${p.pri === 'must' ? '必做' : p.pri === 'opt' ? '備選' : '不做'}` : ''}${why ? `｜${why}` : ''}${String(c.nextStep || '').trim() ? `｜下一步：${String(c.nextStep).trim()}` : ''}${open.length ? `｜未完成待辦：${open.join('；')}` : ''}`;
        };
        return [
            `請當我的時間管理教練，幫我排 ${this.dateLabel(date)} 的今日計畫。`,
            '',
            '【方法】（出自《幫你的時間記帳》）把事情分成固定項、必做項（最多 4 件）、備選項（最多 3 件）；三類合計預估不超過 ' + Math.round(this.budget(date) / 6) / 10 + ' 小時（已扣掉會議）。最重要的事放在最前面、放在我精神最好的時段。',
            '',
            '【任務類型】（決定放哪個時段）',
            ...this.TYPE_ORDER.map(k => `- ${this.TYPES[k].name}：${this.TYPES[k].q}`),
            '看起來像兩種時，選最花腦力的那一段。',
            '',
            '【我的時段】我是中間型（不是早起型也不是夜貓型）。',
            ...this.SLOT_ORDER.map(k => `- ${slots[k].name} ${slots[k].from}–${slots[k].to}（${this.cap(k)} 分鐘）`),
            '原則：分析、研究放精神最好的時段；溝通、雜物放低谷；創造放下午後段。',
            ...(this.accuracyLines().lines.length ? ['', `【我近 30 天的預估偏差】${this.accuracyLines().lines.join('；')}。排的時候請幫我把預估調整得實際一點。`] : []),
            '',
            '【固定項】（已經佔掉的時間）',
            ...(S.fixed.length ? S.fixed.map(r => `- ${this.name(r.card)}：${slots[r.card.fixed.slot]?.name || '未定'} ${r.card.fixed.est} 分鐘`) : ['（沒有）']),
            ...(S.meetings.length ? ['【這天的會議／外出】（已經佔掉的時間）', ...S.meetings.map(m => `- ${m.title}：${slots[m.slot]?.name || ''} ${m.min} 分鐘`)] : []),
            '',
            '【候選】',
            ...items.map(line),
            '',
            '【請你這樣做】',
            '1. 先看候選。類型或重要性判斷不了的，先問我，一次最多 3 個問題，等我回答再繼續。不要自己猜。',
            '2. 討論完，把最後結果放在一個程式碼區塊裡，每件一行，格式：',
            '[編號] 必做|備選|不做 類型 時段 分鐘',
            '例如：[3] 必做 分析 上午 60',
            `類型只能是：分析、研究、創造、溝通、雜物；時段只能是：上午、低谷、下午（分別對應 ${slots.am.name}、${slots.low.name}、${slots.pm.name}）。`,
            '3. 程式碼區塊後面，用 2～3 句告訴我：為什麼這樣排、哪裡可能太滿、有什麼要注意的。'
        ].join('\n');
    },
    async aiSend() {
        const text = app.aiText(this.aiPrompt());
        if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
            try { await navigator.share({ text }); return; } catch (err) { if (err?.name === 'AbortError') return; }
        }
        this.W().copyText(text, '已複製，貼到 AI（Claude、ChatGPT…）。討論完把結果貼回「📥 貼上 AI 的結果」');
    },
    aiMeta() { try { return JSON.parse(localStorage.getItem(this.AI_KEY) || '{}') || {}; } catch (_) { return {}; } },
    parseReflection(text) { const m = String(text || '').match(/^\s*(?:反思|今天的反思)\s*[:：]\s*(.+)$/m); return m ? m[1].trim() : ''; },
    parseAi(text) {
        const meta = this.aiMeta();
        const map = Array.isArray(meta.map) ? meta.map : [];
        const typeBy = Object.fromEntries(this.TYPE_ORDER.map(k => [this.TYPES[k].name, k]));
        const slotBy = { '上午': 'am', '低谷': 'low', '下午': 'pm' };
        const priBy = { '必做': 'must', '備選': 'opt', '不做': 'skip' };
        const out = [];
        String(text || '').split('\n').forEach(l => {
            const m = l.match(/\[(\d+)\]\s*(必做|備選|不做)(?:\s*[|｜]?\s*(分析|研究|創造|溝通|雜物))?(?:\s*[|｜]?\s*(上午|低谷|下午))?(?:\s*[|｜]?\s*(\d+))?/);
            if (!m) return;
            const id = map[Number(m[1]) - 1];
            const card = id ? this.W().getCard(id) : null;
            if (!card) return;
            out.push({ card, pri: priBy[m[2]], type: typeBy[m[3]] || '', slot: slotBy[m[4]] || '', est: Number(m[5]) || 0 });
        });
        return out;
    },
    async aiPaste() {
        this._aiText = '';
        const v = await app.ui.dialog({
            title: '📥 貼上 AI 的結果',
            wide: true,
            html: `<p class="pm-hint" style="margin-top:0;">把 AI 最後給的那段（像「[3] 必做 分析 上午 60」）整段貼上，可以連說明一起貼。</p>
                <textarea class="ps-input" id="td-ai-text" placeholder="貼在這裡…" oninput="app.today._aiText=this.value; app.today.aiPreview()"></textarea>
                <div id="td-ai-preview"></div>`,
            buttons: [{ label: '取消', value: null }, { label: '套用', value: 'ok', primary: true }]
        });
        if (v !== 'ok') return;
        const rows = this.parseAi(this._aiText);
        const meta = this.aiMeta(), note = this.parseReflection(this._aiText);
        if (note && meta.reviewDate) {
            const old = String(app.daylog.get(meta.reviewDate).note || '').trim();
            app.daylog.set(meta.reviewDate, { note: old && !old.includes(note) ? `${old}\n${note}` : (old || note) });
        }
        if (!rows.length) { if (!note) app.ui.toast('沒有讀到結果。請確認貼的是 AI 最後那段「[編號] 必做…」', 'warn'); else this.render(); return; }
        // 排進產生提示時的那一天（收工時＝明天）
        const date = meta.date || this.date();
        rows.forEach(r => {
            if (r.type) r.card.taskType = r.type;
            const cur = this.planOf(r.card, date) || {};
            this.setPlan(r.card, date, {
                pri: r.pri,
                slot: r.pri === 'skip' ? null : (r.slot || cur.slot || (r.type ? this.TYPES[r.type].slot : null)),
                est: r.est || cur.est || this.defaultEst(r.card),
                done: !!cur.done
            });
        });
        app.saveToLocal();
        if (meta.reviewDate) { this.ui.mode = 'plan'; this.ui.which = date === this.todayStr() ? 'today' : 'tomorrow'; }
        this.render();
        app.ui.toast(`已排進 ${this.dateLabel(date)}：${rows.length} 件${note ? '，反思已填進收工帳單' : ''}`);
    },
    aiPreview() {
        const el = document.getElementById('td-ai-preview');
        if (!el) return;
        const rows = this.parseAi(this._aiText);
        const slots = this.slots();
        const pri = { must: '必做', opt: '備選', skip: '不做' };
        const meta = this.aiMeta(), note = this.parseReflection(this._aiText);
        const head = (meta.date ? `<div class="td-meta" style="margin-top:6px;">會排進 ${this.esc(this.dateLabel(meta.date))}${note && meta.reviewDate ? '；反思會填進 ' + this.esc(this.dateLabel(meta.reviewDate)) + ' 的收工帳單' : ''}</div>` : '') + (note ? `<div class="td-ai-note">反思：${this.esc(note)}</div>` : '');
        el.innerHTML = head + (rows.length ? `<div class="td-ai-prev">${rows.map(r => `<div><span class="td-tag ${r.pri}">${pri[r.pri]}</span> ${r.type ? this.TYPES[r.type].icon : ''} ${this.esc(this.name(r.card))} <span class="td-meta">${r.slot ? this.esc(slots[r.slot].name) : ''}${r.est ? ` · ${r.est} 分` : ''}</span></div>`).join('')}</div>`
            : (this._aiText.trim() ? '<div class="td-meta">還沒讀到「[編號] 必做…」這種行。</div>' : ''));
    }
};

// ==========================================
// 🤖 AI 大表：匯出卡片表給 AI 補充／新增 → 貼回 → 逐筆勾選套用
// AI 只能改：標題、專案、類型、預估、下一步；可以新增卡片；可以「建議完成」（預設不勾）。
// 筆記內容、工時、截止日、狀態只給 AI 看，不會被改。
// ==========================================
app.batch = {
    KEY: 'whiteboard_batch_ai',
    state: { scope: '', text: '', rows: null, sel: {} },
    esc(x) { return app.entries.escapeHtml(x); },
    typeName(k) { return app.today.TYPES[k]?.name || ''; },
    typeKey(name) { const n = String(name || '').replace(/型$/, '').trim(); return app.today.TYPE_ORDER.find(k => app.today.TYPES[k].name === n) || ''; },
    clean(v) { return String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim(); },
    UNDO_KEY: 'whiteboard_batch_undo',
    // 這幾個欄位的目前值（用來比對：匯出後你有沒有改過、是不是空白）
    current(card) {
        return { title: String(card.title || '').trim(), project: String(card.project || '').trim(), type: card.taskType || '',
            est: Number(card.plannedMinutes) || 0, next: String(card.nextStep || '').trim() };
    },
    fillEmpty() { return app.settings.get('batchFillEmpty') !== false; },
    setFillEmpty(v) { app.settings.set('batchFillEmpty', !!v); },
    // 代換敏感名稱：「真名=代號」一行一組。複製給 AI 時換成代號，貼回時換回真名。
    maskPairs() {
        return String(app.settings.get('batchMask') || '').split('\n').map(l => l.split(/[=＝]/).map(x => x.trim())).filter(p => p.length === 2 && p[0] && p[1]);
    },
    mask(text) { let t = text; this.maskPairs().forEach(([real, code]) => { t = t.split(real).join(code); }); return t; },
    unmask(text) { let t = text; this.maskPairs().forEach(([real, code]) => { t = t.split(code).join(real); }); return t; },

    scopeCards(scope) {
        return app.worktime.allCards().filter(({ card }) => Number(card.status) !== 2 && !app.sync.isBlankCard(card)
            && !app.projectReg.isClosed(card.project) && (scope === '__all__' || String(card.project || '').trim() === scope));
    },
    defaultScope() {
        const f = app.lists.ui.project;
        if (f) return f;
        const counts = {};
        this.scopeCards('__all__').forEach(({ card }) => { const p = String(card.project || '').trim(); if (p) counts[p] = (counts[p] || 0) + 1; });
        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '__all__';
    },

    prompt(scope) {
        const rows = this.scopeCards(scope);
        const map = rows.map(r => r.card.id);
        const snap = Object.fromEntries(rows.map(r => [r.card.id, this.current(r.card)]));
        try { localStorage.setItem(this.KEY, JSON.stringify({ scope, map, snap, at: Date.now() })); } catch (_) {}
        const W = app.worktime;
        const summary = c => this.clean(String(c.content || '').split('\n').filter(l => l.trim()).slice(0, 3).join(' / ')).slice(0, 80);
        const head = ['編號', '標題', '專案', '類型', '預估分鐘', '下一步', '截止日（唯讀）', '狀態（唯讀）', '筆記摘要（唯讀）'];
        const lines = rows.map(({ card }, i) => [
            `#${i + 1}`, this.clean(app.cardLabel(card)), this.clean(card.project), this.typeName(card.taskType),
            Number(card.plannedMinutes) || '', this.clean(card.nextStep), card.isMemo ? '' : (W.plannedEnd(card) || ''), W.statusLabel(card.status), summary(card)
        ].join('\t'));
        const projects = app.projectReg.names().filter(n => !app.projectReg.isClosed(n));
        return [
            `請幫我整理白板上的工項${scope === '__all__' ? '（全部未完成的卡）' : `（專案：${scope}）`}。目標是讓每件事都變成清楚、可執行的工項。`,
            '',
            '【你可以做的】',
            '1. 補上或修正：標題（改成清楚的動作＋對象，例如「確認流量報表欄位」）、專案、類型、預估分鐘、下一步（下一個具體動作）。',
            '2. 新增卡片：如果某件事太大、或筆記摘要裡藏著別的工項，可以新增卡片。',
            '3. 建議完成：如果看起來已經做完或不需要了，在「建議」欄寫「完成」。（我會自己確認，你不能刪除卡片。）',
            '',
            '【你不能改的】截止日、狀態、筆記內容、工時、工作區。表中標「唯讀」的欄位只是讓你參考。',
            ...(this.fillEmpty() ? ['【只補空白】已經有值的欄位不要改（標題是「未命名」開頭的除外）。只補空白的欄位、新增卡片、建議完成。'] : []),
            '',
            '【類型只能填】' + app.today.TYPE_ORDER.map(k => `${app.today.TYPES[k].name}（${app.today.TYPES[k].q}）`).join('；'),
            `【現有專案】${projects.join('、') || '（無）'}。盡量用現有的；真的需要才開新專案。`,
            '',
            '【請你這樣做】',
            '1. 先看表。不確定的地方（某件在做什麼、該不該拆、屬於哪個專案）先問我，一次最多 3 個問題，等我回答再繼續。不要自己猜。',
            '2. 討論完，把結果放在一個程式碼區塊裡，用 Tab 分隔，第一行是標題列：',
            '編號\t標題\t專案\t類型\t預估分鐘\t下一步\t建議',
            '3. 只列「有改的卡」和「新增的卡」；沒改的不要列。沒改的欄位留空就好（留空＝不改）。',
            '4. 新增的卡，編號寫「新」。',
            '5. 程式碼區塊後面，用 1～3 句說明你做了什麼、還有什麼要我決定。',
            '',
            '【目前的卡片】（Tab 分隔）',
            head.join('\t'),
            ...lines
        ].join('\n');
    },

    // 讀 AI 回傳的表（Tab 或 | 分隔都可以）
    parse(rawText) {
        const text = this.unmask(rawText);
        let meta = {};
        try { meta = JSON.parse(localStorage.getItem(this.KEY) || '{}') || {}; } catch (_) {}
        const map = Array.isArray(meta.map) ? meta.map : [];
        const lines = String(text || '').split('\n').map(l => l.replace(/\r/g, '')).filter(l => l.trim() && !/^\s*```/.test(l) && !/^\s*\|?\s*:?-{2,}/.test(l));
        const split = l => (l.includes('\t') ? l.split('\t') : l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')).map(x => x.trim());
        const headerIdx = lines.findIndex(l => /編號/.test(l) && /標題/.test(l));
        if (headerIdx < 0) return { changes: [], adds: [], warns: ['找不到標題列（第一行要有「編號」「標題」）。'], meta };
        const header = split(lines[headerIdx]);
        const col = name => header.findIndex(h => h.replace(/（.*）|\(.*\)/g, '').trim() === name);
        const C = { id: col('編號'), title: col('標題'), project: col('專案'), type: col('類型'), est: col('預估分鐘'), next: col('下一步'), hint: col('建議') };
        const changes = [], adds = [], warns = [];
        lines.slice(headerIdx + 1).forEach(l => {
            const f = split(l);
            const get = k => C[k] >= 0 ? this.clean(f[C[k]] ?? '') : '';
            const idRaw = get('id');
            // 只認「#數字」「數字」「新」開頭的列；AI 的說明文字直接略過
            if (!idRaw || !/^(#?\d+|新)/.test(idRaw)) return;
            const typeRaw = get('type'), estRaw = get('est');
            const type = typeRaw ? this.typeKey(typeRaw) : '';
            if (typeRaw && !type) warns.push(`「${typeRaw}」不是五種類型之一，已略過（${idRaw}）。`);
            const est = estRaw ? Math.round(Number(String(estRaw).replace(/[^\d.]/g, ''))) : 0;
            if (estRaw && !(est > 0)) warns.push(`預估「${estRaw}」看不懂，已略過（${idRaw}）。`);
            const vals = { title: get('title'), project: get('project'), type, est: est > 0 ? est : 0, next: get('next'), done: /完成/.test(get('hint')) };
            if (/^新/.test(idRaw)) {
                if (!vals.title) { warns.push('有一列新增的卡沒有標題，已略過。'); return; }
                adds.push(vals);
                return;
            }
            const n = Number(idRaw.replace(/[^\d]/g, ''));
            const id = map[n - 1];
            const card = id ? app.worktime.getCard(id) : null;
            if (!card) { warns.push(`找不到 ${idRaw}（可能是不同一次匯出的表），已略過。`); return; }
            const W = app.worktime;
            const fields = [];
            const now = this.current(card), was = meta.snap?.[card.id];
            const flag = f => {
                // 匯出後你又改過這一欄 → 衝突；只補空白模式下要蓋掉已有的值 → 覆寫。兩種都預設不勾。
                if (was && f.k !== 'done' && JSON.stringify(was[f.k]) !== JSON.stringify(now[f.k])) f.conflict = true;
                else if (this.fillEmpty() && f.k !== 'done' && now[f.k] && !(f.k === 'title' && /^未命名/.test(app.cardLabel(card)))) f.overwrite = true;
                return f;
            };
            if (vals.title && vals.title !== now.title) fields.push(flag({ k: 'title', label: '標題', from: now.title, to: vals.title }));
            if (vals.project && vals.project !== now.project) fields.push(flag({ k: 'project', label: '專案', from: now.project, to: vals.project }));
            if (vals.type && vals.type !== now.type) fields.push(flag({ k: 'type', label: '類型', from: this.typeName(now.type), to: this.typeName(vals.type), val: vals.type }));
            if (vals.est && vals.est !== now.est) fields.push(flag({ k: 'est', label: '預估', from: now.est ? W.formatMinutes(now.est) : '', to: W.formatMinutes(vals.est), val: vals.est }));
            if (vals.next && vals.next !== now.next) fields.push(flag({ k: 'next', label: '下一步', from: now.next, to: vals.next }));
            if (vals.done && Number(card.status) !== 2) fields.push({ k: 'done', label: '建議完成', from: '', to: '標成完成' });
            if (fields.length) changes.push({ n: idRaw, card, fields });
        });
        return { changes, adds, warns, meta };
    },

    async open() {
        this.state = { scope: this.defaultScope(), text: '', rows: null, sel: {}, tabId: app.state.activeTabId };
        const names = app.projectReg.names().filter(n => !app.projectReg.isClosed(n) && this.scopeCards(n).length);
        setTimeout(() => this.count(), 30);
        const v = await app.ui.dialog({
            title: '🤖 AI 大表：批次補充與新增',
            wide: true,
            html: `<div class="bt-step"><b>① 選範圍，複製給 AI</b>
                    <div class="bt-row">
                        <select onchange="app.batch.state.scope=this.value; app.batch.count()">${names.map(n => `<option value="${this.esc(n)}" ${n === this.state.scope ? 'selected' : ''}>${this.esc(n)}</option>`).join('')}<option value="__all__" ${this.state.scope === '__all__' ? 'selected' : ''}>全部未完成的卡</option></select>
                        <span id="bt-count" class="td-meta"></span>
                        <button type="button" class="rv-btn" onclick="app.batch.send()">🤖 複製給 AI</button>
                    </div>
                    <label class="bt-opt"><input type="checkbox" ${this.fillEmpty() ? 'checked' : ''} onchange="app.batch.setFillEmpty(this.checked)"> 只補空白欄位（已經填好的不讓 AI 改，建議開著）</label>
                    <div class="td-meta">AI 只能改：標題、專案、類型、預估、下一步；可以新增卡片；可以「建議完成」。筆記內容、工時、截止日、狀態、工作區不會被改。建議一次一個專案，比較好檢查。</div>
                    <details class="bt-mask"><summary>代換敏感名稱（${this.maskPairs().length} 組）</summary>
                        <div class="td-meta">複製給 AI 前把真名換成代號，貼回時自動換回來。一行一組：真名=代號，例如「化學物質管理署=甲機關」。</div>
                        <textarea class="ps-input" style="min-height:60px;" onchange="app.settings.set('batchMask', this.value)">${this.esc(app.settings.get('batchMask') || '')}</textarea>
                    </details>
                </div>
                <div class="bt-step"><b>② 把 AI 最後給的表貼回來</b>
                    <textarea class="ps-input" id="bt-text" placeholder="整段貼上（含程式碼區塊也可以）" oninput="app.batch.state.text=this.value; app.batch.preview()"></textarea>
                    <div class="bt-row"><span class="td-meta">新增的卡放到工作區：</span><select onchange="app.batch.state.tabId=this.value">${app.state.tabs.filter(t => !/^♻/.test(t.name)).map(t => `<option value="${t.id}" ${t.id === app.state.activeTabId ? 'selected' : ''}>${this.esc(t.name)}</option>`).join('')}</select></div>
                    <div id="bt-preview"></div>
                </div>`,
            buttons: [{ label: '取消', value: null }, { label: '套用勾選的變更', value: 'ok', primary: true }]
        });
        if (v === 'ok') this.apply();
    },
    count() { const el = document.getElementById('bt-count'); if (el) el.textContent = `${this.scopeCards(this.state.scope).length} 張未完成的卡`; },
    async send() {
        const text = this.mask(app.aiText(this.prompt(this.state.scope)));
        if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
            try { await navigator.share({ text }); return; } catch (err) { if (err?.name === 'AbortError') return; }
        }
        app.worktime.copyText(text, '已複製，貼到 AI。討論完把它最後給的表貼回第②步');
    },
    preview() {
        const el = document.getElementById('bt-preview');
        if (!el) return;
        if (!this.state.text.trim()) { el.innerHTML = ''; return; }
        const R = this.parse(this.state.text);
        this.state.rows = R;
        const esc = x => this.esc(x), sel = this.state.sel;
        const key = (i, j) => `c${i}_${j}`;
        R.changes.forEach((c, i) => c.fields.forEach((f, j) => { const k = key(i, j); if (sel[k] === undefined) sel[k] = f.k !== 'done' && !f.conflict && !f.overwrite; }));
        R.adds.forEach((a, i) => { if (sel[`a${i}`] === undefined) sel[`a${i}`] = true; });
        const box = (k, label) => `<label class="bt-chk"><input type="checkbox" ${sel[k] ? 'checked' : ''} onchange="app.batch.state.sel['${k}']=this.checked">${label}</label>`;
        const n = R.changes.reduce((a, c) => a + c.fields.length, 0);
        el.innerHTML = `${R.warns.length ? `<div class="bt-warn">${R.warns.map(w => `<div>⚠ ${esc(w)}</div>`).join('')}</div>` : ''}
            <div class="td-meta" style="margin:6px 0;">讀到 ${R.changes.length} 張卡的 ${n} 個變更、${R.adds.length} 張新卡。沒勾的不會改。「建議完成」、你改過的欄位、會蓋掉已填值的，預設都不勾。</div>
            ${R.changes.map((c, i) => `<div class="bt-card"><div class="bt-card-title">${esc(c.n)} ${esc(app.cardLabel(c.card))}</div>
                ${c.fields.map((f, j) => box(key(i, j), `<span class="bt-label ${f.k === 'done' ? 'done' : ''}">${esc(f.label)}</span> ${f.k === 'done' ? '' : `<span class="bt-from">${esc(f.from || '（空）')}</span> → `}<b>${esc(f.to)}</b>${f.conflict ? ' <span class="bt-flag">⚠ 匯出後你改過這欄</span>' : ''}${f.overwrite ? ' <span class="bt-flag">會蓋掉已填的值</span>' : ''}`)).join('')}
            </div>`).join('')}
            ${R.adds.length ? `<div class="bt-card"><div class="bt-card-title">＋ 新增的卡</div>${R.adds.map((a, i) => box(`a${i}`, `<b>${esc(a.title)}</b> <span class="td-meta">${[a.project && '#' + a.project, a.type && this.typeName(a.type), a.est && a.est + ' 分', a.next && '下一步：' + a.next].filter(Boolean).map(esc).join('・')}</span>`)).join('')}</div>` : ''}`;
    },
    apply() {
        const R = this.state.rows || this.parse(this.state.text);
        if (!R || (!R.changes.length && !R.adds.length)) { app.ui.toast('沒有讀到可以套用的變更', 'warn'); return; }
        const sel = this.state.sel;
        let nChange = 0, nAdd = 0, nDone = 0;
        const undo = { at: Date.now(), fields: [], created: [], done: [] };
        R.changes.forEach((c, i) => c.fields.forEach((f, j) => {
            if (!sel[`c${i}_${j}`]) return;
            const card = app.worktime.getCard(c.card.id);
            if (!card) return;
            if (f.k === 'done') undo.done.push({ id: card.id, status: card.status, progress: card.progress, actualEnd: card.actualEnd, actualStart: card.actualStart });
            else undo.fields.push({ id: card.id, k: f.k, prev: this.current(card)[f.k], applied: f.val ?? f.to });
            if (f.k === 'title') card.title = f.to;
            else if (f.k === 'project') card.project = f.to;
            else if (f.k === 'type') card.taskType = f.val;
            else if (f.k === 'est') { card.plannedMinutes = f.val; delete card.plannedHours; }
            else if (f.k === 'next') { card.nextStep = f.to; card.nextAction = f.to; }
            else if (f.k === 'done') { app.worktime.markCompleted(card); nDone++; return; }
            nChange++;
        }));
        const scope = R.meta?.scope && R.meta.scope !== '__all__' ? R.meta.scope : '';
        R.adds.forEach((a, i) => {
            if (!sel[`a${i}`]) return;
            const card = app.quickAdd.create({ title: a.title, tabId: this.state.tabId || app.state.activeTabId, project: a.project || scope });
            undo.created.push(card.id);
            if (a.type) card.taskType = a.type;
            if (a.est) card.plannedMinutes = a.est;
            if (a.next) { card.nextStep = a.next; card.nextAction = a.next; }
            nAdd++;
        });
        try { localStorage.setItem(this.UNDO_KEY, JSON.stringify(undo)); } catch (_) {}
        app.saveToLocal();
        app.ui.defer(() => app.renderAll());
        app.ui.toast(`已套用：${nChange} 個變更、新增 ${nAdd} 張${nDone ? `、${nDone} 張標成完成` : ''}。可以在卡片表按「↶ 復原」整批還原。`, 'info', 6000);
    },

    lastUndo() { try { const u = JSON.parse(localStorage.getItem(this.UNDO_KEY) || 'null'); return u && (u.fields.length || u.created.length || u.done.length) ? u : null; } catch (_) { return null; } },
    // 整批復原：欄位改回原值（套用後你又改過的就不動）、刪掉新增的卡（進最近刪除）、重新打開被標完成的卡
    async undo() {
        const u = this.lastUndo();
        if (!u) return;
        const n = u.fields.length + u.created.length + u.done.length;
        if (!await app.ui.confirm('復原上一次 AI 大表', `<p>${app.ui.fmtTime(u.at)} 套用的 ${n} 項變更要全部還原？新增的 ${u.created.length} 張卡會移到「最近刪除」。套用之後你自己又改過的欄位不會動。</p>`, '復原')) return;
        let restored = 0, skipped = 0;
        u.fields.forEach(x => {
            const card = app.worktime.getCard(x.id);
            if (!card) return;
            const cur = this.current(card)[x.k];
            if (JSON.stringify(cur) !== JSON.stringify(x.applied)) { skipped++; return; }
            if (x.k === 'title') card.title = x.prev;
            else if (x.k === 'project') card.project = x.prev;
            else if (x.k === 'type') { if (x.prev) card.taskType = x.prev; else delete card.taskType; }
            else if (x.k === 'est') { if (x.prev) card.plannedMinutes = x.prev; else delete card.plannedMinutes; }
            else if (x.k === 'next') { card.nextStep = x.prev; card.nextAction = x.prev; }
            restored++;
        });
        u.done.forEach(x => {
            const card = app.worktime.getCard(x.id);
            if (!card) return;
            ['status', 'progress', 'actualEnd', 'actualStart'].forEach(k => { if (x[k] === undefined) delete card[k]; else card[k] = x[k]; });
            restored++;
        });
        const made = u.created.map(id => { const tabId = app.actions.tabOfCard(id); const card = tabId ? app.state.workspaces[tabId].find(c => c.id === id) : null; return card ? { card, tabId } : null; }).filter(Boolean);
        if (made.length && await app.backup.trashOrConfirm(made, '復原 AI 大表')) {
            const ids = new Set(made.map(m => m.card.id));
            Object.keys(app.state.workspaces).forEach(t => { app.state.workspaces[t] = app.state.workspaces[t].filter(c => !ids.has(c.id)); });
            restored += made.length;
        }
        try { localStorage.removeItem(this.UNDO_KEY); } catch (_) {}
        app.saveToLocal();
        app.ui.defer(() => app.renderAll());
        app.ui.toast(`已復原 ${restored} 項${skipped ? `；${skipped} 個欄位你後來又改過，沒有動` : ''}`, 'info', 6000);
    }
};

// ==========================================
// 專案選擇：點下去列出所有專案；打了沒有的名字＝「＋ 新增專案」
// ==========================================
app.projectPicker = {
    el: null, input: null, idx: -1, items: [],
    open(input) {
        this.input = input;
        this.showAll = true;
        if (!this.el) {
            this.el = document.createElement('div');
            this.el.className = 'pp-menu';
            this.el.addEventListener('mousedown', e => e.preventDefault());
            document.body.appendChild(this.el);
            window.addEventListener('scroll', () => this.place(), true);
            window.addEventListener('resize', () => this.place());
        }
        if (!input._ppBound) {
            input._ppBound = true;
            input.addEventListener('input', () => { this.showAll = false; this.render(); });
            input.addEventListener('keydown', e => this.key(e));
            input.addEventListener('blur', () => setTimeout(() => { if (this.input === input && document.activeElement !== input) this.close(); }, 120));
        }
        this.render();
    },
    close() { if (this.el) this.el.style.display = 'none'; this.idx = -1; },
    place() {
        if (!this.el || this.el.style.display === 'none' || !this.input?.isConnected) return this.close();
        const r = this.input.getBoundingClientRect();
        this.el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 248))}px`;
        this.el.style.top = `${r.bottom + 2}px`;
        this.el.style.minWidth = `${Math.max(r.width, 200)}px`;
    },
    render() {
        const esc = x => app.entries.escapeHtml(x);
        const v = String(this.input?.value || '').trim();
        const all = app.projectReg.names().filter(p => !app.projectReg.isClosed(p) || p === v);
        const q = v.toLowerCase();
        const list = this.showAll || !v ? all : all.filter(p => p.toLowerCase().includes(q));
        this.items = list.map(p => ({ value: p, label: p }));
        if (v && !all.some(p => p === v)) this.items.unshift({ value: v, label: `＋ 新增專案「${v}」`, isNew: true });
        if (v) this.items.push({ value: '', label: '清除（不設專案）', clear: true });
        this.el.innerHTML = this.items.length ? this.items.map((it, i) => `<div class="pp-item ${it.isNew ? 'new' : ''} ${it.clear ? 'clear' : ''} ${it.value === v && !it.isNew && !it.clear ? 'cur' : ''} ${i === this.idx ? 'hi' : ''}" onclick="app.projectPicker.choose(${i})">${esc(it.label)}</div>`).join('')
            : '<div class="pp-empty">還沒有專案，直接打名字就是新專案</div>';
        this.el.style.display = 'block';
        this.place();
    },
    choose(i) {
        const it = this.items[i];
        const input = this.input;
        if (!it || !input) return;
        input.value = it.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        this.close();
        if (it.isNew) app.ui.toast(`新專案「${it.value}」`);
    },
    key(e) {
        if (!this.el || this.el.style.display === 'none') return;
        if (e.key === 'ArrowDown') { e.preventDefault(); this.idx = Math.min(this.items.length - 1, this.idx + 1); this.render(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); this.idx = Math.max(-1, this.idx - 1); this.render(); }
        else if (e.key === 'Enter' && !e.isComposing && this.idx >= 0) { e.preventDefault(); e.stopPropagation(); this.choose(this.idx); }
        else if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
    }
};

// ==========================================
// ＋ 卡片：在原地快速新增（不跳去時間軸）。一行一張卡。
// ==========================================
app.quickAdd = {
    form: { text: '', tabId: '', project: '', date: '' },

    // 比對用：去掉空白和標點、轉小寫
    norm(t) { return String(t || '').split('\n')[0].toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); },
    // 找已經存在、還沒完成、名稱相同或互相包含（4 個字以上）的卡
    findSimilar(title) {
        const n = this.norm(title);
        if (!n) return [];
        return app.worktime.allCards().filter(({ card, tabName }) => {
            if (Number(card.status) === 2 || /^♻/.test(tabName)) return false;
            const m = this.norm(card.title);
            if (!m) return false;
            return m === n || (Math.min(m.length, n.length) >= 4 && (m.includes(n) || n.includes(m)));
        });
    },
    // 新增前檢查重複：回傳要新增的標題（取消＝null）
    async confirmNew(titles) {
        const hits = titles.map(t => ({ t, rows: this.findSimilar(t) })).filter(h => h.rows.length);
        if (!hits.length) return titles;
        const esc = x => app.entries.escapeHtml(x);
        const W = app.worktime;
        const v = await app.ui.dialog({
            title: '已經有類似的卡',
            wide: true,
            html: `<p style="margin-top:0;">下面的卡可能已經存在，不用重建。它們在今日頁的候選裡找得到（沒有急迫理由的排在各專案的後面）。</p>
                <div class="diff-block">${hits.map(h => `<div style="padding:4px 0;"><b>${esc(h.t)}</b><br>${h.rows.slice(0, 3).map(({ card, tabName }) => `<span style="color:#475569;font-size:.85rem;">→ 已有：${esc(String(card.title || '').split('\n')[0])}（${esc(tabName)}${card.project ? '・#' + esc(card.project) : ''}・${esc(W.statusLabel(card.status))}）</span>`).join('<br>')}</div>`).join('')}</div>`,
            buttons: [{ label: '取消', value: null }, { label: '全部照樣新增', value: 'all' }, { label: titles.length > hits.length ? '只新增沒重複的' : '不新增', value: 'new', primary: true }]
        });
        if (!v) return null;
        if (v === 'all') return titles;
        const dup = new Set(hits.map(h => h.t));
        return titles.filter(t => !dup.has(t));
    },

    // 共用：建立一張卡（卡片表最下面那列也用這個）
    create({ title, tabId, project = '', date = '' }) {
        const W = app.worktime;
        const today = W.localDateString();
        const tab = app.state.tabs.some(t => t.id === tabId) ? tabId : app.state.activeTabId;
        const scheduled = !!W.parseLocalDate(date);
        const card = {
            id: app.makeId('card'), title: String(title || '').trim(), content: '', project: String(project || '').trim(),
            category: '', progress: '', deliverable: '', acceptance: '', workLogs: [],
            dateMode: scheduled ? 'range' : 'single', dateSingle: '',
            dateStart: scheduled ? (date < today ? date : today) : '', dateEnd: scheduled ? date : '',
            color: 'blue', status: 0, isMemo: !scheduled
        };
        if (!app.state.workspaces[tab]) app.state.workspaces[tab] = [];
        app.state.workspaces[tab].push(card);
        return card;
    },

    open() {
        const esc = x => app.entries.escapeHtml(x);
        const f = this.form;
        f.text = '';
        f.tabId = (app.state.view === 'lists' && app.lists.ui.ctTab) || app.state.activeTabId;
        if (app.state.view === 'lists' && app.lists.ui.project && !f.project) f.project = app.lists.ui.project;
        const tabs = app.state.tabs;
        app.ui.dialog({
            title: '＋ 新增卡片',
            html: `<textarea id="qa-text" class="ps-input" style="min-height:70px;" placeholder="卡片標題，按 Enter 建立&#10;一次貼好幾行＝每行一張卡（Shift+Enter 換行）" oninput="app.quickAdd.form.text=this.value; app.quickAdd.hint()" onkeydown="if(event.key==='Enter' && !event.shiftKey && !event.isComposing){ event.preventDefault(); this.closest('.app-dialog').querySelector('.app-dialog-btn.primary').click(); }"></textarea>
                <div class="qa-fields">
                    <label>工作區<select onchange="app.quickAdd.form.tabId=this.value">${tabs.map(t => `<option value="${t.id}" ${t.id === f.tabId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
                    <label>專案<input class="qa-project" value="${esc(f.project)}" placeholder="可不填，點一下選或打新的" autocomplete="off" onfocus="app.projectPicker.open(this)" oninput="app.quickAdd.form.project=this.value"></label>
                    <label>預計完成<input type="date" value="${esc(f.date)}" oninput="app.quickAdd.form.date=this.value"></label>
                </div>
                <div id="qa-hint" class="pm-hint">沒填日期＝自由卡片；填了＝排程工項。建好後留在原本的畫面。</div>`,
            buttons: [{ label: '取消', value: null }, { label: '建立', value: 'ok', primary: true }]
        }).then(v => {
            if (v !== 'ok') return;
            const titles = String(f.text || '').split('\n').map(t => t.replace(/^\s*(?:[-*•・]\s+(?:\[[ xX]\]\s*)?|\d{1,2}[.)、．]\s*)/, '').trim()).filter(Boolean);
            if (!titles.length) return;
            return this.confirmNew(titles).then(keep => {
            if (!keep || !keep.length) return;
            const made = keep.map(title => this.create({ title, tabId: f.tabId, project: f.project, date: f.date }));
            app.saveToLocal();
            app.ui.defer(() => app.renderAll());
            const tabName = app.state.tabs.find(t => t.id === f.tabId)?.name || '';
            app.ui.toast(made.length > 1 ? `已新增 ${made.length} 張卡到「${tabName}」` : `已新增「${made[0].title}」到「${tabName}」`);
            f.date = '';
            });
        });
        setTimeout(() => document.getElementById('qa-text')?.focus(), 30);
    },

    hint() {
        const el = document.getElementById('qa-hint');
        const n = String(this.form.text || '').split('\n').filter(l => l.trim()).length;
        if (el) el.textContent = n > 1 ? `會建立 ${n} 張卡（一行一張）。` : '沒填日期＝自由卡片；填了＝排程工項。建好後留在原本的畫面。';
    }
};

// ==========================================
// 📝 整理成 Trello 紀錄：段落結束時（完成、告一段落、筆記太長）把脈絡交給 AI 照格式寫，貼到 Trello；
// 白板只留連結。格式可以自己改（跟著雲端同步）。
// ==========================================
app.docRecord = {
    DEFAULT_TEMPLATE: [
        '# {專案}｜{標題}',
        '',
        '## 背景',
        '為什麼有這件事、誰提出、牽涉哪些單位或人。',
        '',
        '## 目標與交付',
        '要交出什麼；怎樣算完成。',
        '',
        '## 過程紀錄',
        '依日期排序，一行一筆：日期｜做了什麼｜結果。',
        '',
        '## 決定與原因',
        '做了哪些決定、為什麼。沒有就寫「無」。',
        '',
        '## 問題與回答',
        '❓ 問題 → 💬 回答；還沒有答案的標「待確認」。',
        '',
        '## 目前狀態',
        '完成／進行中；下一步；在等誰、等什麼。',
        '',
        '## 相關連結與附件',
        '連結列表。',
        '📷 建議截圖：標出哪些地方放截圖最能看懂脈絡（我會自己貼）。'
    ].join('\n'),
    state: { cardId: '', result: '' },
    esc(x) { return app.entries.escapeHtml(x); },
    template() { return String(app.settings.get('trelloTemplate') || '').trim() || this.DEFAULT_TEMPLATE; },
    data(card) {
        const W = app.worktime, tabId = app.actions.tabOfCard(card.id);
        const st = ['未開始', '進行中', '已完成', '卡住／等待'][Number(card.status) || 0] || '';
        const logs = (card.workLogs || []).slice().sort((a, b) => String(a.workDate).localeCompare(String(b.workDate)))
            .map(l => `- ${l.workDate}｜${Math.round(l.minutes)} 分｜${String(l.note || '').replace(/\n/g, ' ')}`);
        const entries = (card.entries || []).map(e => `- ${String(e.createdAt || '').slice(0, 10)}｜${e.title || ''}：${String(e.content || '').replace(/\n+/g, ' ').slice(0, 400)}`);
        const refs = (card.refs || []).map(r => r.type === 'card' ? `- 相關卡片：${W.getCard(r.cardId)?.title || r.title || ''}` : `- ${r.title || ''} ${r.url || ''}`.trim());
        const note = String(card.content || '').trim();
        return [
            `標題：${card.title || '（未命名）'}`,
            `專案：${card.project || '雜項'}　工作區：${app.state.tabs.find(t => t.id === tabId)?.name || ''}`,
            `狀態：${st}　預計：${W.plannedStart(card) || '—'} ～ ${W.plannedEnd(card) || '—'}　實際：${card.actualStart || '—'} ～ ${card.actualEnd || '—'}`,
            `總工時：${W.formatMinutes(W.totalMinutes(card))}`,
            card.deliverable ? `要交出什麼：${card.deliverable}` : '',
            card.acceptance ? `怎樣算完成：${card.acceptance}` : '',
            card.nextStep ? `下一步：${card.nextStep}` : '',
            (card.waitingWho || card.waitingWhat) ? `在等：${card.waitingWho || ''} ${card.waitingWhat || ''}（追蹤日 ${card.followUpDate || '未定'}）` : '',
            '', '【筆記】（含 - [ ] 待辦、❓ 問題、💬 回答、🕒 時間戳記）', note ? (note.length > 8000 ? note.slice(0, 8000) + '\n…（後面省略）' : note) : '（沒有）',
            ...(entries.length ? ['', '【工作紀錄】', ...entries] : []),
            ...(logs.length ? ['', '【工時紀錄】', ...logs.slice(-60)] : []),
            ...(refs.length ? ['', '【參考】', ...refs] : [])
        ].filter(x => x !== '').join('\n').replace(/\n{3,}/g, '\n\n');
    },
    prompt(card) {
        return [
            '請把下面這張工作卡的資料，整理成一份 Trello 卡片描述，讓之後的我（或接手的人）不用問就看得懂脈絡。',
            '規則：',
            '1. 照【格式】的段落寫，用 Markdown（Trello 支援）。段落沒有資料就寫「（待補）」，不要自己補成事實。',
            '2. 過程紀錄依日期整理，合併重複、刪掉瑣碎的計時，留下有意義的進展與結果。',
            '3. 在適合放截圖的地方標「📷 建議截圖：…」，說明要截什麼。',
            '4. 簡潔，條列為主。最後只輸出卡片描述本身，放在一個程式碼區塊裡，方便我複製。',
            '',
            '【格式】', this.template(),
            '',
            '【卡片資料】', this.data(card)
        ].join('\n');
    },
    open(cardId) {
        const card = app.worktime.getCard(cardId); if (!card) return;
        this.state = { cardId, result: '' };
        const esc = x => this.esc(x), masked = (app.batch?.maskPairs?.() || []).length;
        app.ui.dialog({
            title: `📝 整理成 Trello 紀錄：${card.title || '（未命名）'}`,
            wide: true,
            html: `<p class="pm-hint" style="margin-top:0;">段落結束時用：卡片完成、告一段落，或筆記太長不想留在白板上。圖片 AI 放不了，貼到 Trello 時自己補。</p>
                <div class="bt-step"><b>① 複製給 AI</b>
                    <div class="bt-row"><button type="button" class="worklog-add-btn" onclick="app.docRecord.send()">🤖 複製提示（含「關於我」${masked ? `，${masked} 組敏感名稱會先代換` : ''}）</button></div>
                    <details><summary class="pm-hint">紀錄格式（可以改，會記住）</summary>
                        <textarea class="ps-input" style="min-height:160px;" onchange="app.docRecord.saveTemplate(this.value)">${esc(this.template())}</textarea>
                        <button type="button" class="ps-mini" onclick="app.docRecord.saveTemplate(''); app.ui.toast('已恢復預設格式，重新打開就看得到')">恢復預設格式</button>
                    </details>
                </div>
                <div class="bt-step"><b>② 把 AI 寫好的貼回來</b>${masked ? '<span class="pm-hint">（代號會自動換回真名）</span>' : '<span class="pm-hint">（可略過，直接從 AI 複製到 Trello 也行）</span>'}
                    <textarea class="ps-input" id="dr-result" style="min-height:120px;" placeholder="整段貼上，包含程式碼區塊也可以" oninput="app.docRecord.state.result=this.value"></textarea>
                    <div class="bt-row"><button type="button" class="worklog-add-btn" onclick="app.docRecord.copyResult()">📋 複製成 Trello 用的文字</button></div>
                </div>
                <div class="bt-step"><b>③ 貼到 Trello 後，把網址貼回來</b>
                    <input class="task-meta-input" id="dr-url" value="${esc(card.docUrl || '')}" placeholder="https://trello.com/c/…" style="width:100%;">
                    <label class="pm-hint" style="display:flex;gap:6px;align-items:center;margin-top:6px;"><input type="checkbox" id="dr-log" checked> 在卡片筆記最後加一行「已整理到 Trello」（日期＋連結）</label>
                </div>`,
            buttons: [{ label: '關閉', value: null }, { label: '儲存連結', value: 'ok', primary: true }]
        }).then(v => {
            if (v !== 'ok') return;
            const url = String(document.getElementById('dr-url')?.value || this._url || '').trim();
            this.saveUrl(cardId, url, this._log !== false);
        });
        setTimeout(() => {
            const u = document.getElementById('dr-url'), l = document.getElementById('dr-log');
            this._url = u?.value || ''; this._log = true;
            u?.addEventListener('input', () => { this._url = u.value; });
            l?.addEventListener('change', () => { this._log = l.checked; });
        }, 30);
    },
    saveTemplate(v) { app.settings.set('trelloTemplate', String(v || '').trim() && String(v).trim() !== this.DEFAULT_TEMPLATE ? String(v).trim() : undefined); },
    async send() {
        const card = app.worktime.getCard(this.state.cardId); if (!card) return;
        let text = app.aiText(this.prompt(card));
        if (app.batch?.mask) text = app.batch.mask(text);
        if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
            try { await navigator.share({ text }); return; } catch (err) { if (err?.name === 'AbortError') return; }
        }
        app.worktime.copyText(text, '已複製，貼到 AI。寫好後貼回第②步');
    },
    clean(raw) {
        let t = String(raw || '');
        const m = t.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/);
        if (m) t = m[1];
        if (app.batch?.unmask) t = app.batch.unmask(t);
        return t.trim();
    },
    copyResult() {
        const t = this.clean(this.state.result || document.getElementById('dr-result')?.value);
        if (!t) { app.ui.toast('先把 AI 寫好的內容貼到第②步', 'warn'); return; }
        app.worktime.copyText(t, '已複製，貼到 Trello 卡片的描述');
    },
    saveUrl(cardId, url, log) {
        const card = app.worktime.getCard(cardId); if (!card) return;
        if (!url) return;
        const changed = card.docUrl !== url;
        card.docUrl = url;
        if (log) {
            const W = app.worktime, d = W.localDateString();
            card.content = String(card.content || '').replace(/\s*$/, '') + `${card.content ? '\n' : ''}📁 ${d} 已整理到 Trello：${url}`;
        }
        app.saveToLocal();
        app.refreshCard ? app.refreshCard(cardId) : app.renderAll();
        app.ui.toast(changed || log ? '已存好 Trello 連結' : '連結沒有變');
    }
};

// ==========================================
// ♟ 棋盤＝一張卡的拆解圖：卡片是母，棋子是子（＝卡片筆記裡的「- [ ]」待辦）。
// 子項目底下縮排的幾行是它的細節；長大的子項目可以「升格」成子卡（parentId 連回母卡）。
// 座標只記在 card.boardMeta，筆記文字保持乾淨。
// ==========================================
app.board = {
    LETTERS: 'ABCDEFGHJKLMNOPQRST',
    pick: null,
    cardId: '',
    esc(x) { return app.entries.escapeHtml(x); },
    coord(x, y) { return this.LETTERS[x] + (19 - y); },
    parseAt(s) {
        const m = String(s || '').trim().match(/^([A-HJ-Ta-hj-t])(1[0-9]|[1-9])$/);
        return m ? { x: this.LETTERS.indexOf(m[1].toUpperCase()), y: 19 - Number(m[2]) } : null;
    },
    parseCoord(t) {
        const m = String(t || '').match(/^\s*([A-HJ-Ta-hj-t])(1[0-9]|[1-9])(?:\s+|[:：]\s*)([\s\S]+)$/);
        if (!m) return null;
        return { x: this.LETTERS.indexOf(m[1].toUpperCase()), y: 19 - Number(m[2]), text: m[3].trim() };
    },
    key(t) { return String(t || '').replace(/\s+/g, ' ').trim(); },
    card() { return this.cardId ? app.worktime.getCard(this.cardId) : null; },
    meta(card) { if (!card.boardMeta || typeof card.boardMeta !== 'object') card.boardMeta = {}; return card.boardMeta; },

    // 子項目：最外層的「- [ ]」；它下面縮排更深的行＝細節
    children(card) {
        const lines = String(card?.content || '').split('\n');
        const re = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/;
        const hits = lines.map((l, i) => { const m = l.match(re); return m ? { i, ind: m[1].replace(/\t/g, '    ').length, done: m[2].toLowerCase() === 'x', text: m[3].trim() } : null; }).filter(Boolean);
        if (!hits.length) return [];
        const top = Math.min(...hits.map(h => h.ind));
        const meta = card.boardMeta || {};
        return hits.filter(h => h.ind === top).map(h => {
            const details = [];
            for (let j = h.i + 1; j < lines.length; j++) {
                const l = lines[j];
                if (!l.trim()) { if (details.length) break; else continue; }
                const ind = (l.match(/^\s*/)[0] || '').replace(/\t/g, '    ').length;
                if (ind <= top) break;
                details.push(l.trim());
            }
            const k = this.key(h.text), m = meta[k] || {};
            const child = m.cardId ? app.worktime.getCard(m.cardId) : null;
            return { lineIndex: h.i, text: h.text, key: k, done: child ? Number(child.status) === 2 : h.done, details, at: this.parseAt(m.at), black: !!m.black, childCard: child };
        });
    },
    // 沒有座標的子項目自動排（從中央往右排）
    layout(card) {
        const kids = this.children(card), used = new Set();
        kids.forEach(c => { if (c.at) used.add(c.at.x + ',' + c.at.y); });
        let changed = false;
        kids.forEach(c => {
            if (c.at) return;
            const p = this.freePoint(9, 9, used);
            used.add(p.x + ',' + p.y);
            c.at = p; this.meta(card)[c.key] = { ...(this.meta(card)[c.key] || {}), at: this.coord(p.x, p.y) }; changed = true;
        });
        if (changed) app.saveToLocal();
        return kids;
    },
    freePoint(fx = 9, fy = 9, used) {
        const taken = used || new Set(this.layoutNoSave().map(c => c.at && (c.at.x + ',' + c.at.y)));
        for (let r = 0; r <= 18; r++) {
            const ring = [];
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([dx, dy]);
            ring.sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]) || (a[0] < 0) - (b[0] < 0) || Math.abs(a[0]) - Math.abs(b[0]) || (a[1] < 0) - (b[1] < 0));
            for (const [dx, dy] of ring) {
                const x = fx + dx, y = fy + dy;
                if (x < 0 || y < 0 || x > 18 || y > 18) continue;
                if (!taken.has(x + ',' + y)) return { x, y };
            }
        }
        return { x: fx, y: fy };
    },
    layoutNoSave() { const c = this.card(); return c ? this.children(c) : []; },
    occupied(x, y) { return this.layoutNoSave().some(c => c.at && c.at.x === x && c.at.y === y); },

    // ---------- 打開 ----------
    open(cardId) {
        const card = cardId ? app.worktime.getCard(cardId) : null;
        this.cardId = card ? card.id : '';
        this.pick = null;
        try { if (card) localStorage.setItem('whiteboard_board_last', card.id); } catch (_) {}
        app.switchView('matrix');
        setTimeout(() => document.getElementById('matrix-quick-input')?.focus(), 50);
    },
    openLast() {
        let id = '';
        try { id = localStorage.getItem('whiteboard_board_last') || ''; } catch (_) {}
        this.open(app.worktime.getCard(id) ? id : '');
    },

    // ---------- 畫面 ----------
    gridHtml(card, kids) {
        const esc = x => this.esc(x);
        let html = '';
        [3, 9, 15].forEach(x => [3, 9, 15].forEach(y => { html += `<div class="star-point" style="left:${x / 18 * 100}%; top:${y / 18 * 100}%;"></div>`; }));
        for (let i = 0; i < 19; i++) {
            const p = i / 18 * 100;
            html += `<span class="bd-coord top" style="left:${p}%">${this.LETTERS[i]}</span><span class="bd-coord left" style="top:${p}%">${19 - i}</span>`;
        }
        if (this.pick) html += `<div class="bd-pick" style="left:${this.pick.x / 18 * 100}%; top:${this.pick.y / 18 * 100}%;"></div>`;
        html += kids.map((c, idx) => {
            const { x, y } = c.at;
            const st = c.done ? 'done' : (c.childCard ? (app.today.isWaiting(c.childCard) ? 'wait' : 'card') : 'todo');
            const stText = { done: '✓ 完成', card: '↗ 已升格成卡片', wait: '⏳ 子卡在追', todo: '' }[st];
            return `<div class="matrix-node ${c.black ? 'stone-black' : 'stone-white'} linked st-${st}" data-id="${idx}" style="left:${x / 18 * 100}%; top:${y / 18 * 100}%;">
                <div class="node-stone"></div>
                <div class="node-paper">
                    <div class="bd-head"><span class="bd-c">${this.coord(x, y)}</span></div>
                    <div class="matrix-node-text">${esc(c.text)}</div>
                    ${c.details.length ? `<div class="bd-note">${c.details.slice(0, 6).map(d => esc(d.replace(/^[-*]\s+/, ''))).join('<br>')}${c.details.length > 6 ? '<br>…' : ''}</div>` : ''}
                    ${stText ? `<div class="bd-st ${st}">${stText}</div>` : ''}
                    <div class="node-action-group">
                        ${c.childCard ? `<button class="node-action-btn" onclick="app.board.open('${c.childCard.id}')" title="打開子卡的棋盤">♟</button><button class="node-action-btn" onclick="app.today.focus('${c.childCard.id}')" title="打開子卡（專注）">↗</button>`
                            : `<button class="node-action-btn" onclick="app.board.toggleDone(${idx})" title="${c.done ? '改回未完成' : '完成'}">${c.done ? '↩' : '✓'}</button>`}
                        <button class="node-action-btn" onclick="app.board.edit(${idx})" title="改名、寫細節">✎</button>
                        <button class="node-action-btn" onclick="app.board.toggleBlack(${idx})" title="黑子＝警戒、還不確定">☯️</button>
                        ${c.childCard ? '' : `<button class="node-action-btn" onclick="app.board.promote(${idx})" title="升格成子卡（一天做不完、有自己的截止日、要等別人時）">⬆</button>`}
                        <button class="node-action-btn del" style="color:#ef4444;" onclick="app.board.remove(${idx})" title="刪除這個子項目">×</button>
                    </div>
                </div>
            </div>`;
        }).join('');
        return html;
    },
    renderFull() {
        const grid = document.getElementById('matrix-grid-lines'); if (!grid) return;
        const card = this.card();
        const board = document.getElementById('matrix-board');
        const bar = document.getElementById('matrix-bar-extra');
        const inputBar = document.querySelector('#view-matrix .matrix-input-bar');
        if (!card) {
            grid.innerHTML = '';
            if (board) board.style.display = 'none';
            if (inputBar) inputBar.style.display = 'none';
            if (bar) bar.innerHTML = this.pickerHtml();
            return;
        }
        if (board) board.style.display = '';
        if (inputBar) inputBar.style.display = '';
        const kids = this.layout(card);
        grid.innerHTML = this.gridHtml(card, kids);
        this.renderBar(card, kids);
        if (board && !board._bdClick) { board._bdClick = true; board.addEventListener('click', e => this.boardClick(e)); }
    },
    renderBar(card, kids) {
        const el = document.getElementById('matrix-bar-extra'); if (!el) return;
        const esc = x => this.esc(x);
        const parent = card.parentId ? app.worktime.getCard(card.parentId) : null;
        const done = kids.filter(c => c.done).length;
        el.innerHTML = `<div class="bd-title">
                <button type="button" class="bd-back" onclick="app.board.open('')" title="換一張卡">☰ 換卡片</button>
                ${parent ? `<button type="button" class="bd-back" onclick="app.board.open('${parent.id}')" title="回到母卡的棋盤">↰ ${esc(parent.title || '母卡')}</button>` : ''}
                <b>♟ ${esc(card.title || '（未命名）')}</b><span class="td-meta">${esc(card.project || '雜項')} · 子項目 ${kids.length} · 完成 ${done}</span>
                <button type="button" class="bd-back" onclick="app.today.focus('${card.id}')" title="打開這張卡（筆記、計時）">↗ 打開卡片</button>
            </div>
            <span class="bd-tools"><button type="button" class="primary" onclick="app.board.aiOpen()" title="讓 AI 幫這張卡拆子項目，或檢查你的拆法">🤖 和 AI 一起拆</button>
                <button type="button" onclick="app.board.editZones()" title="寫下你的分區習慣，AI 會照著放">🗺 我的分區</button></span>
            <span class="bd-legend"><span><i style="border-color:#818cf8"></i>子項目</span><span><i style="border-color:#22c55e"></i>完成</span><span><i style="border-color:#0ea5e9"></i>已升格成卡片</span><span><i style="border-color:#f59e0b"></i>子卡在追</span><span>黑子＝警戒</span></span>
            <span class="td-meta">${this.pick ? `下一顆落在 <b>${this.coord(this.pick.x, this.pick.y)}</b>（<a href="#" onclick="app.board.pick=null; app.board.renderFull(); return false;">取消</a>）` : '點交叉點選位置，或打「D4 內容」；子項目會寫進這張卡的筆記'}</span>`;
        const inp = document.getElementById('matrix-quick-input');
        if (inp) inp.placeholder = this.pick ? `＋ 子項目，落在 ${this.coord(this.pick.x, this.pick.y)}…（Enter）` : '＋ 子項目（Enter 落子；可打「D4 內容」指定位置）';
    },
    pickerHtml() {
        const esc = x => this.esc(x), q = String(this._q || '').trim().toLowerCase();
        const rows = app.worktime.allCards().filter(({ card, tabName }) => Number(card.status) !== 2 && !/^♻/.test(tabName) && !app.sync.isBlankCard(card) && !card.fixed)
            .filter(({ card }) => !q || [card.title, card.project].some(x => String(x || '').toLowerCase().includes(q)));
        const withKids = rows.filter(({ card }) => this.children(card).length).sort((a, b) => this.children(b.card).length - this.children(a.card).length);
        const others = rows.filter(({ card }) => !this.children(card).length);
        const legacy = app.state.tabs.reduce((n, t) => n + (app.state.nodes[t.id] || []).length, 0);
        const row = ({ card, tabName }) => `<button type="button" class="bd-pick-card" onclick="app.board.open('${card.id}')"><b>${esc(card.title || '（未命名）')}</b><span class="td-meta">${esc(card.project || '雜項')} · ${esc(tabName)}${this.children(card).length ? ` · 子項目 ${this.children(card).length}` : ''}</span></button>`;
        return `<div class="bd-picker">
            <h4>♟ 選一張卡來拆</h4>
            <p class="pm-hint" style="margin-top:0;">棋盤是一張卡的拆解圖：卡片是母，棋子是子項目（＝卡片筆記裡的待辦）。也可以從卡片上的「♟ 棋盤」直接打開。</p>
            <input type="search" class="td-search" placeholder="找卡片…" value="${esc(this._q || '')}" oninput="app.board._q=this.value; clearTimeout(app.board._qt); app.board._qt=setTimeout(()=>app.board.renderFull(),200)">
            ${legacy ? `<div class="td-backup">舊棋盤上還有 ${legacy} 顆棋子。<button type="button" onclick="app.board.migrateOpen()">搬進卡片</button></div>` : ''}
            ${withKids.length ? `<div class="td-meta" style="margin:8px 0 4px;">已經有子項目的</div><div class="bd-pick-list">${withKids.slice(0, 30).map(row).join('')}</div>` : ''}
            <div class="td-meta" style="margin:8px 0 4px;">其他卡片</div><div class="bd-pick-list">${others.slice(0, 60).map(row).join('') || '<div class="td-meta">沒有</div>'}</div>
        </div>`;
    },
    boardClick(e) {
        if (e.target.closest('.matrix-node') || app.dragState.isDragging || !this.card()) return;
        const grid = document.getElementById('matrix-grid-lines'), r = grid.getBoundingClientRect();
        const x = Math.round((e.clientX - r.left) / r.width * 18), y = Math.round((e.clientY - r.top) / r.height * 18);
        if (x < 0 || y < 0 || x > 18 || y > 18 || this.occupied(x, y)) return;
        this.pick = this.pick && this.pick.x === x && this.pick.y === y ? null : { x, y };
        this.renderFull();
        document.getElementById('matrix-quick-input')?.focus();
    },

    // ---------- 編輯：一律改卡片筆記 ----------
    lines(card) { return String(card.content || '').split('\n'); },
    save(card) { app.saveToLocal(); this.renderFull(); app.ui.defer?.(() => app.refreshCard?.(card.id)); },
    addChild(card, text, at, details = []) {
        const t = this.key(text); if (!t) return;
        const kids = this.children(card);
        const lines = this.lines(card);
        const indent = kids.length ? (lines[kids[0].lineIndex].match(/^\s*/)[0] || '') : '';
        const block = [`${indent}- [ ] ${t}`, ...details.filter(Boolean).map(d => `${indent}  - ${d}`)];
        // 接在最後一個子項目（含它的細節）後面；沒有子項目就加在筆記最後
        let insertAt = lines.length;
        if (kids.length) { const last = kids[kids.length - 1]; insertAt = last.lineIndex + 1 + last.details.length; while (insertAt < lines.length && !lines[insertAt].trim() && insertAt === last.lineIndex + 1 + last.details.length && false) insertAt++; }
        else { while (lines.length && !lines[lines.length - 1].trim()) lines.pop(); insertAt = lines.length; }
        lines.splice(insertAt, 0, ...block);
        card.content = lines.join('\n').replace(/^\n+/, '');
        this.meta(card)[t] = { ...(this.meta(card)[t] || {}), at: this.coord(at.x, at.y) };
    },
    addFromInput() {
        const card = this.card(); if (!card) return;
        const inputEl = document.getElementById('matrix-quick-input');
        let text = String(inputEl?.value || '').trim(); if (!text) return;
        let at;
        const pc = this.parseCoord(text);
        if (pc) { text = pc.text; at = this.occupied(pc.x, pc.y) ? this.freePoint(pc.x, pc.y) : pc; }
        else if (this.pick) at = this.occupied(this.pick.x, this.pick.y) ? this.freePoint(this.pick.x, this.pick.y) : this.pick;
        else { const kids = this.layoutNoSave(); const last = kids[kids.length - 1]; at = this.freePoint(last?.at?.x ?? 9, last?.at?.y ?? 9); }
        if (this.children(card).some(c => c.key === this.key(text))) { app.ui.toast('這張卡已經有同名的子項目', 'warn'); return; }
        this.addChild(card, text, at);
        this.pick = this.freePoint(at.x, at.y, new Set([...this.layoutNoSave().map(c => c.at && (c.at.x + ',' + c.at.y)), at.x + ',' + at.y]));
        if (inputEl) inputEl.value = '';
        this.save(card);
    },
    kid(idx) { const card = this.card(); const kids = card ? this.children(card) : []; return { card, c: kids[idx] }; },
    move(idx, x, y) {
        const { card, c } = this.kid(Number(idx)); if (!c) return;
        if (this.layoutNoSave().some((k, i) => i !== Number(idx) && k.at && k.at.x === x && k.at.y === y)) { this.renderFull(); return; }
        this.meta(card)[c.key] = { ...(this.meta(card)[c.key] || {}), at: this.coord(x, y) };
        app.saveToLocal(); this.renderFull();
    },
    toggleBlack(idx) {
        const { card, c } = this.kid(idx); if (!c) return;
        const m = this.meta(card)[c.key] = { ...(this.meta(card)[c.key] || {}) };
        if (m.black) delete m.black; else m.black = true;
        app.saveToLocal(); this.renderFull();
    },
    toggleDone(idx) {
        const { card, c } = this.kid(idx); if (!c) return;
        app.sandbox.toggleSubtask(card.id, c.lineIndex);
        this.renderFull();
    },
    async edit(idx) {
        const { card, c } = this.kid(idx); if (!c) return;
        this._ed = { text: c.text, details: c.details.map(d => d.replace(/^[-*]\s+/, '')).join('\n') };
        const esc = x => this.esc(x);
        const v = await app.ui.dialog({
            title: `✎ ${this.coord(c.at.x, c.at.y)}`,
            html: `<div class="qa-fields"><label style="flex:1;">子項目${c.childCard ? '（也會改子卡的標題）' : ''}<input id="bd-rn" value="${esc(this._ed.text)}" oninput="app.board._ed.text=this.value"></label></div>
                <label class="pm-hint" style="display:block;margin-top:6px;">細節（一行一點：聯絡人、連結、備註、❓ 問題）</label>
                <textarea class="ps-input" style="min-height:110px;" oninput="app.board._ed.details=this.value">${esc(this._ed.details)}</textarea>`,
            buttons: [{ label: '取消', value: null }, { label: '儲存', value: 'ok', primary: true }]
        });
        if (v !== 'ok') return;
        const nt = this.key(this._ed.text); if (!nt) return;
        if (nt !== c.key && this.children(card).some(k => k.key === nt)) { app.ui.toast('已經有同名的子項目', 'warn'); return; }
        const lines = this.lines(card), head = lines[c.lineIndex];
        const indent = head.match(/^\s*/)[0] || '';
        lines[c.lineIndex] = head.replace(/(\[[ xX]\]\s+).*$/, `$1${nt}`);
        const det = String(this._ed.details || '').split('\n').map(x => x.trim()).filter(Boolean).map(d => `${indent}  ${/^[-*]\s/.test(d) || /^[❓💬]/.test(d) ? d : '- ' + d}`);
        lines.splice(c.lineIndex + 1, c.details.length, ...det);
        card.content = lines.join('\n');
        if (nt !== c.key) { const m = this.meta(card); m[nt] = m[c.key]; delete m[c.key]; }
        if (c.childCard) c.childCard.title = nt;
        this.save(card);
    },
    async remove(idx) {
        const { card, c } = this.kid(idx); if (!c) return;
        if (!await app.ui.confirm('刪除子項目', `<p>從「${this.esc(card.title || '')}」的筆記刪掉「${this.esc(c.text)}」${c.details.length ? `和底下 ${c.details.length} 行細節` : ''}？${c.childCard ? '<br>子卡本身會保留。' : ''}</p>`, '刪除', true)) return;
        const lines = this.lines(card);
        lines.splice(c.lineIndex, 1 + c.details.length);
        card.content = lines.join('\n');
        delete this.meta(card)[c.key];
        if (c.childCard && c.childCard.parentId === card.id) delete c.childCard.parentId;
        this.save(card);
    },
    // ⬆ 升格：子項目變成一張子卡，細節搬過去，母子互相連結
    promote(idx) {
        const { card, c } = this.kid(idx); if (!c || c.childCard) return;
        const tabId = app.actions.tabOfCard(card.id) || app.state.activeTabId;
        const child = app.quickAdd.create({ title: c.text, tabId, project: card.project || '' });
        child.content = c.details.map(d => d.startsWith('- ') || /^[❓💬]/.test(d) ? d : '- ' + d).join('\n');
        child.parentId = card.id;
        child.refs = [{ id: app.makeId('ref'), type: 'card', cardId: card.id, title: card.title || '', note: '母卡', createdAt: new Date().toISOString() }];
        if (c.done) app.worktime.markCompleted(child);
        this.meta(card)[c.key] = { ...(this.meta(card)[c.key] || {}), cardId: child.id };
        this.save(card);
        app.ui.toast(`「${c.text}」已升格成子卡，在母卡棋盤上點 ♟ 可以繼續往下拆`);
    },
    // 子卡完成 → 母卡上的那一行也勾起來（母卡全部勾完會照原本規則完成）
    syncParent(child) {
        const parent = child?.parentId ? app.worktime.getCard(child.parentId) : null; if (!parent) return;
        const c = this.children(parent).find(k => k.childCard && k.childCard.id === child.id); if (!c) return;
        const line = this.lines(parent)[c.lineIndex], isX = /\[[xX]\]/.test(line), want = Number(child.status) === 2;
        if (isX !== want) app.sandbox.toggleSubtask(parent.id, c.lineIndex);
    },

    // ---------- 舊棋盤（工作區的棋子）搬進卡片 ----------
    async migrateOpen() {
        const tabs = app.state.tabs.filter(t => (app.state.nodes[t.id] || []).length);
        if (!tabs.length) return;
        const tab = tabs[0], nodes = app.state.nodes[tab.id];
        const cards = (app.state.workspaces[tab.id] || []).filter(c => Number(c.status) !== 2 && !app.sync.isBlankCard(c));
        this._mg = { target: '__new__' };
        const esc = x => this.esc(x);
        const v = await app.ui.dialog({
            title: `搬進卡片：「${tab.name}」的 ${nodes.length} 顆舊棋子`,
            wide: true,
            html: `<p class="pm-hint" style="margin-top:0;">每顆棋子會變成那張卡的一個子項目，位置保留。已經轉成卡片的棋子，會變成「已升格」的子項目（連到原本的卡）。</p>
                <div class="bd-pe-list">${nodes.map(n => `<div class="bd-pe"><b class="bd-c" style="display:inline">${this.coord(n.gridX ?? 9, n.gridY ?? 9)}</b><span>${esc(n.text)}</span>${n.cardId ? '<span class="td-meta">（已是卡片）</span>' : ''}</div>`).join('')}</div>
                <div class="qa-fields" style="margin-top:8px;"><label style="flex:1;">搬到哪張卡<select onchange="app.board._mg.target=this.value"><option value="__new__">新開一張「${esc(tab.name)} 的拆解」</option>${cards.map(c => `<option value="${c.id}">${esc(c.title || '（未命名）')}</option>`).join('')}</select></label></div>`,
            buttons: [{ label: '取消', value: null }, { label: '搬進去', value: 'ok', primary: true }]
        });
        if (v !== 'ok') return;
        let card = this._mg.target === '__new__' ? null : app.worktime.getCard(this._mg.target);
        if (!card) card = app.quickAdd.create({ title: `${tab.name} 的拆解`, tabId: tab.id, project: nodes.find(n => n.project)?.project || '' });
        await app.backup.save(`舊棋盤搬進卡片前（${tab.name}）`, app.store.serialize());
        nodes.forEach(n => {
            const linked = n.cardId ? app.worktime.getCard(n.cardId) : null;
            const text = this.key(linked ? linked.title : n.text); if (!text) return;
            if (this.children(card).some(c => c.key === text)) return;
            const at = { x: n.gridX ?? 9, y: n.gridY ?? 9 };
            this.addChild(card, text, this.children(card).some(c => c.at && c.at.x === at.x && c.at.y === at.y) ? this.freePoint(at.x, at.y, new Set(this.children(card).map(c => c.at && (c.at.x + ',' + c.at.y)))) : at, n.note ? [n.note] : []);
            const m = this.meta(card)[text];
            if (n.stoneColor === 'black') m.black = true;
            if (linked) { m.cardId = linked.id; if (!linked.parentId) linked.parentId = card.id; }
        });
        app.state.nodes[tab.id] = [];
        app.saveToLocal();
        this.open(card.id);
        app.ui.toast(`已搬進「${card.title}」。搬之前的版本存在「🗂 資料 → 本機快照」`);
    },

    // ---------- 🗺 我的分區 ----------
    zones() { return String(app.settings.get('boardZones') || '').trim(); },
    async editZones() {
        this._z = this.zones();
        const v = await app.ui.dialog({
            title: '🗺 我的分區',
            html: `<p class="pm-hint" style="margin-top:0;">寫下你習慣把什麼放在哪一區。AI 拆的時候會照著放座標；不寫也可以。</p>
                <textarea class="ps-input" style="min-height:110px;" placeholder="例如：&#10;左下（A–G, 1–7）＝前期：需求、訪談、資料&#10;右下（N–T, 1–7）＝開發與製作&#10;右上（N–T, 13–19）＝上線、驗收、交付&#10;左上（A–G, 13–19）＝溝通協調、等別人&#10;中腹＝還不確定、要研究的" oninput="app.board._z=this.value">${this.esc(this._z)}</textarea>`,
            buttons: [{ label: '取消', value: null }, { label: '儲存', value: 'ok', primary: true }]
        });
        if (v === 'ok') { app.settings.set('boardZones', this._z.trim() || undefined); app.ui.toast('已存好分區'); }
    },

    // ---------- 🤖 和 AI 一起拆（拆的是這張卡） ----------
    ai: { mode: 'split', goal: '', text: '', rows: [] },
    aiPrompt() {
        const A = this.ai, card = this.card(); if (!card) return '';
        const kids = this.children(card);
        const parent = card.parentId ? app.worktime.getCard(card.parentId) : null;
        const p = String(card.project || '').trim();
        const b = p && app.coach?.brief ? app.coach.brief(p) : {};
        const brief = [['目的', b.goal], ['交付', b.deliverable], ['期限', b.deadline], ['相關的人', b.stakeholders], ['限制', b.constraints]].filter(x => String(x[1] || '').trim()).map(([k, v]) => `- ${k}：${v}`);
        const W = app.worktime;
        const notes = String(card.content || '').split('\n').filter(l => !/^\s*[-*]\s+\[[ xX]\]/.test(l)).join('\n').trim();
        const ask = A.mode === 'review'
            ? ['請檢查我這張卡目前的拆法（子項目）：', '1. 有沒有漏掉的？有沒有重複、或太大要再拆的（太大的建議我「升格」成子卡）？', '2. 哪些其實是還沒驗證的假設或未知，應該先確認？', '3. 位置是否符合我的分區？', '先用條列說明（簡短），最後把「建議新增」的子項目用下面格式列出（沒有就寫「無」）。']
            : ['請幫我把這張卡拆成子項目：4～9 個，每個是做完看得到結果的一塊（不是太細的動作）。', '資訊不足時，先問我最多 3 個問題；我回答後再給最後結果。', '還不確定、要先研究的，名稱用「❓」開頭。', '依我的分區放座標，避開已經有子項目的位置，相關的放相鄰。'];
        return [
            '我用一個 19 路棋盤拆解一張工作卡：卡片是母，每顆棋子是一個子項目，位置是我自己分的區（座標像圍棋：A–T 不含 I，1–19，1 在最下面）。',
            '', ...ask, '',
            '【輸出格式】最後結果放在一個程式碼區塊裡，一行一個：',
            '```', '座標 | 子項目名稱（15 字內） | 一句細節', 'D4 | 需求訪談 | 跟承辦確認範圍與時程', '```', '',
            `【這張卡】${card.title || '（未命名）'}`,
            `專案：${p || '雜項'}${parent ? `　母卡：${parent.title}` : ''}　預計完成：${W.plannedEnd(card) || '未定'}`,
            card.deliverable ? `要交出什麼：${card.deliverable}` : '', card.acceptance ? `怎樣算完成：${card.acceptance}` : '',
            ...(brief.length ? ['【專案簡述】', ...brief] : []),
            A.goal.trim() ? `【我補充】${A.goal.trim()}` : '',
            notes ? `【卡片筆記（節錄）】\n${notes.slice(0, 3000)}` : '',
            this.zones() ? `【我的分區】\n${this.zones()}` : '【我的分區】沒有固定，請你排並說明分區邏輯。',
            '【目前的子項目】', ...(kids.length ? kids.map(c => `- ${this.coord(c.at?.x ?? 9, c.at?.y ?? 9)}　${c.text}${c.done ? '［完成］' : ''}${c.childCard ? '［已升格成卡片］' : ''}${c.black ? '［警戒］' : ''}${c.details.length ? `：${c.details.slice(0, 3).join('；')}` : ''}`) : ['（還沒有）'])
        ].filter(x => x !== '').join('\n');
    },
    aiOpen() {
        const card = this.card(); if (!card) return;
        const A = this.ai; A.text = ''; A.rows = [];
        const esc = x => this.esc(x), masked = (app.batch?.maskPairs?.() || []).length;
        app.ui.dialog({
            title: `🤖 和 AI 一起拆：${card.title || '（未命名）'}`,
            wide: true,
            html: `<div class="bt-step"><b>① 告訴 AI 要做什麼</b>
                    <div class="bd-modes"><label><input type="radio" name="bd-mode" ${A.mode !== 'review' ? 'checked' : ''} onchange="app.board.ai.mode='split'"> 幫我拆子項目</label><label><input type="radio" name="bd-mode" ${A.mode === 'review' ? 'checked' : ''} onchange="app.board.ai.mode='review'"> 檢查我現在的拆法</label></div>
                    <textarea class="ps-input" style="min-height:60px;" placeholder="想補充的（可空白）：例如「明年 6 月上線，要先做使用者調查」" oninput="app.board.ai.goal=this.value">${esc(A.goal)}</textarea>
                    <div class="bt-row"><button type="button" class="worklog-add-btn" onclick="app.board.aiSend()">🤖 複製給 AI</button><span class="pm-hint">會帶上：關於我、這張卡（交付、筆記）、專案簡述、我的分區、目前子項目${masked ? `；${masked} 組敏感名稱先代換` : ''}。</span></div>
                </div>
                <div class="bt-step"><b>② 把 AI 最後給的表貼回來</b>
                    <textarea class="ps-input" id="bd-ai-text" style="min-height:90px;" placeholder="整段貼上也可以，只會讀「座標 | 名稱 | 細節」的行" oninput="app.board.ai.text=this.value; app.board.aiPreview()"></textarea>
                    <div id="bd-ai-preview"></div>
                </div>`,
            buttons: [{ label: '取消', value: null }, { label: '加入勾選的子項目', value: 'ok', primary: true }]
        }).then(v => { if (v === 'ok') this.aiApply(); });
    },
    async aiSend() {
        let text = app.aiText(this.aiPrompt());
        if (app.batch?.mask) text = app.batch.mask(text);
        if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
            try { await navigator.share({ text }); return; } catch (err) { if (err?.name === 'AbortError') return; }
        }
        app.worktime.copyText(text, '已複製，貼到 AI。討論完把最後的表貼回第②步');
    },
    aiParse(raw) {
        let t = String(raw || '');
        if (app.batch?.unmask) t = app.batch.unmask(t);
        const card = this.card(), have = new Set(card ? this.children(card).map(c => c.key) : []);
        const rows = [], seen = new Set();
        t.split('\n').forEach(line => {
            const m = line.replace(/^\s*[-*•]\s*/, '').match(/^\s*([A-HJ-Ta-hj-t])\s*(1[0-9]|[1-9])\s*[|｜]\s*([^|｜]+?)\s*(?:[|｜]\s*(.*?))?\s*$/);
            if (!m) return;
            const name = this.key(m[3].replace(/^\*\*|\*\*$/g, '')); if (!name || /^(子項目)?名稱/.test(name) || seen.has(name)) return;
            seen.add(name);
            const x = this.LETTERS.indexOf(m[1].toUpperCase()), y = 19 - Number(m[2]);
            rows.push({ x, y, name, note: (m[4] || '').trim(), on: !have.has(name), dup: have.has(name), taken: this.occupied(x, y) });
        });
        return rows;
    },
    aiPreview() {
        const el = document.getElementById('bd-ai-preview'); if (!el) return;
        const A = this.ai; A.rows = this.aiParse(A.text);
        const esc = x => this.esc(x);
        el.innerHTML = A.rows.length ? `<div class="pm-hint">讀到 ${A.rows.length} 個，會寫進這張卡的筆記（- [ ] 子項目，細節縮排在下面）。</div>
            <div class="bd-pe-list">${A.rows.map((r, i) => `<label class="bd-pe"><input type="checkbox" ${r.on ? 'checked' : ''} onchange="app.board.ai.rows[${i}].on=this.checked"><b class="bd-c" style="display:inline">${this.coord(r.x, r.y)}</b><span>${esc(r.name)}${r.note ? `<span class="td-meta">　${esc(r.note)}</span>` : ''}</span>${r.dup ? '<span class="td-why wait">已經有了</span>' : ''}${r.taken ? '<span class="td-meta">（位置有子，會放旁邊）</span>' : ''}</label>`).join('')}</div>`
            : (A.text.trim() ? '<div class="pm-hint">還沒讀到「座標 | 名稱 | 細節」的行。</div>' : '');
    },
    aiApply() {
        const card = this.card(); if (!card) return;
        const rows = (this.ai.rows || []).filter(r => r.on && !r.dup);
        if (!rows.length) return;
        rows.forEach(r => {
            const at = this.occupied(r.x, r.y) ? this.freePoint(r.x, r.y) : { x: r.x, y: r.y };
            this.addChild(card, r.name, at, r.note ? [r.note] : []);
        });
        this.save(card);
        app.ui.toast(`已加入 ${rows.length} 個子項目到「${card.title}」`);
    }
};

// ==========================================
// ✅ 清單：所有卡片的待辦、問題、問答集中在一頁（資料仍在卡片筆記裡，改這裡＝改卡片）
// ==========================================
app.lists = {
    ui: { tab: 'todo', project: '', search: '', showDone: false, showArchived: true, addCard: '', ctTab: '', ctStatus: 'open', ctSort: 'due', ctGroup: 'none', ctCollapsed: {} },

    esc(s) { return app.entries.escapeHtml(s); },
    cardTitle(card) { return app.cardLabel(card); },

    rows() {
        const W = app.worktime, U = this.ui, q = U.search.trim().toLowerCase();
        return W.allCards().filter(({ card }) => {
            if (U.project && String(card.project || '').trim() !== U.project) return false;
            return true;
        }).map(r => ({ ...r, q }));
    },
    match(q, ...texts) { return !q || texts.some(t => String(t || '').toLowerCase().includes(q)); },

    collect() {
        const out = { todoOpen: [], todoDone: [], todoArchived: [], qOpen: [], qAnswered: [], qArchived: [] };
        this.rows().forEach(({ card, tabId, tabName, q }) => {
            const base = { card, tabId, tabName };
            const title = this.cardTitle(card);
            app.sandbox.parseSubtasks(card.content).forEach(st => {
                if (!this.match(q, st.text, title)) return;
                (st.completed ? out.todoDone : out.todoOpen).push({ ...base, ...st });
            });
            app.questions.parse(card.content).forEach(x => {
                if (!this.match(q, x.text, ...x.answers, title)) return;
                (x.answers.some(Boolean) ? out.qAnswered : out.qOpen).push({ ...base, ...x });
            });
            (card.entries || []).forEach(en => {
                const date = String(en.createdAt ? app.worktime.localDateString(new Date(en.createdAt)) : '').slice(0, 10);
                String(en.content || '').split('\n').forEach(l => {
                    const m = l.trim().match(/^✅\s*(.+)$/);
                    if (m && this.match(q, m[1], title)) out.todoArchived.push({ ...base, text: m[1], date });
                });
                app.questions.parse(en.content).forEach(x => {
                    if (this.match(q, x.text, ...x.answers, title)) out.qArchived.push({ ...base, ...x, date });
                });
            });
        });
        out.todoArchived.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        out.qArchived.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        return out;
    },

    set(key, val) { this.ui[key] = val; this.savePrefs(); this.render(); },

    // 記住分頁、篩選、排序、分組（只存在這台電腦的瀏覽器）
    PREF_KEYS: ['tab', 'project', 'ctTab', 'ctStatus', 'ctSort', 'ctGroup', 'ctCollapsed'],
    savePrefs() {
        try { localStorage.setItem('whiteboard_lists_ui', JSON.stringify(Object.fromEntries(this.PREF_KEYS.map(k => [k, this.ui[k]])))); } catch (_) {}
    },
    loadPrefs() {
        if (this._prefsLoaded) return;
        this._prefsLoaded = true;
        try { const v = JSON.parse(localStorage.getItem('whiteboard_lists_ui') || '{}'); this.PREF_KEYS.forEach(k => { if (v[k] !== undefined) this.ui[k] = v[k]; }); } catch (_) {}
    },

    projects() {
        const fromCards = app.worktime.allCards().map(({ card }) => String(card.project || '').trim()).filter(Boolean);
        let reg = [];
        try { reg = Object.keys(JSON.parse(app.state.sandbox.projects || '{}')); } catch (_) {}
        return [...new Set([...fromCards, ...reg])].sort();
    },

    // 依卡片分組
    grouped(list, itemHtml) {
        const groups = new Map();
        list.forEach(x => { if (!groups.has(x.card.id)) groups.set(x.card.id, { ...x, items: [] }); groups.get(x.card.id).items.push(x); });
        return [...groups.values()].map(g => `<div class="ls-group">
            <div class="ls-group-head">
                <button type="button" class="ls-card-link" onclick="app.actions.jumpToCard('${g.card.id}','${g.tabId}')" title="到時間軸看這張卡">${this.esc(this.cardTitle(g.card))}</button>
                <span class="ls-meta">${g.card.project ? '#' + this.esc(g.card.project) + ' · ' : ''}${this.esc(g.tabName)}${Number(g.card.status) === 2 ? ' · 已完成' : ''}</span>
                ${app.sandbox.doneState(g.card) === 'ask-complete' ? `<button type="button" class="ls-complete" onclick="app.lists.complete('${g.card.id}')" title="待辦都勾完了">✅ 標記卡片完成</button>` : ''}
                <button type="button" class="ls-focus" onclick="app.sandbox.focusTaskForTimer('${g.card.id}')" title="進心流專注這張卡">🎯</button>
            </div>
            ${g.items.map(itemHtml).join('')}
        </div>`).join('');
    },

    section(title, count, body, { open = true, key = '' } = {}) {
        if (!count) return '';
        const k = `open_${this.ui.tab}_${key}`;
        if (key && this.ui[k] !== undefined) open = this.ui[k];
        return `<details class="ls-section" ${open ? 'open' : ''} ${key ? `ontoggle="app.lists.ui['${k}']=this.open"` : ''}><summary>${title} <span class="ls-count">${count}</span></summary>${body}</details>`;
    },

    todoItem(x) {
        return `<label class="ls-item ${x.completed ? 'done' : ''}"><input type="checkbox" ${x.completed ? 'checked' : ''} onchange="app.lists.toggleTodo('${x.card.id}', ${x.lineIndex}, ${this.esc(JSON.stringify(x.text))})"><span>${this.esc(x.text)}</span></label>`;
    },

    qItem(x, editable) {
        const ans = x.answers.filter(Boolean).map(a => `<div class="ls-answer">💬 ${this.esc(a)}</div>`).join('');
        const input = editable ? `<input type="text" class="ls-answer-input" placeholder="${x.answers.some(Boolean) ? '補充答案…' : '寫答案，按 Enter'}" onkeydown="if(event.key==='Enter' && !event.isComposing){ app.lists.answer('${x.card.id}', ${x.line}, ${this.esc(JSON.stringify(x.text))}, this.value); }">` : '';
        return `<div class="ls-q"><div class="ls-q-text">❓ ${this.esc(x.text)}${x.date ? ` <span class="ls-meta">${this.esc(x.date)} 整理</span>` : ''}</div>${ans}${input}</div>`;
    },

    render() {
        const target = document.getElementById('lists-render-target');
        if (!target) return;
        this.loadPrefs();
        const U = this.ui, d = this.collect();
        const active = document.activeElement;
        const keepSearch = active && active.id === 'ls-search' ? active.selectionStart : null;
        const openCards = app.worktime.allCards().filter(({ card }) => Number(card.status) !== 2 && (!U.project || String(card.project || '').trim() === U.project)).length;
        const tabs = [['todo', `✅ 待辦 <b>${d.todoOpen.length}</b>`], ['question', `❓ 問題 <b>${d.qOpen.length}</b>`], ['review', `💬 問答回顧 <b>${d.qAnswered.length + d.qArchived.length}</b>`], ['cards', `🗂 卡片 <b>${openCards}</b>`], ['projects', `📁 專案 <b>${app.projectReg.names().filter(n => !app.projectReg.isClosed(n)).length}</b>`]];
        const cards = app.worktime.allCards().filter(({ card }) => Number(card.status) !== 2 && (!U.project || String(card.project || '').trim() === U.project));
        const defCard = U.addCard && cards.some(r => r.card.id === U.addCard) ? U.addCard : (app.state.sandbox.activeTaskId && cards.some(r => r.card.id === app.state.sandbox.activeTaskId) ? app.state.sandbox.activeTaskId : (cards[0]?.card.id || ''));
        let body = '';
        if (U.tab === 'todo') {
            body = `<div class="ls-add">
                    <input type="text" id="ls-add-text" placeholder="新增待辦，按 Enter" onkeydown="if(event.key==='Enter' && !event.isComposing) app.lists.add(this.value)">
                    <select id="ls-add-card" onchange="app.lists.ui.addCard=this.value" title="加到哪張卡">${cards.map(r => `<option value="${r.card.id}" ${r.card.id === defCard ? 'selected' : ''}>${this.esc(this.cardTitle(r.card))}</option>`).join('')}</select>
                </div>
                ${d.todoOpen.length ? this.grouped(d.todoOpen, x => this.todoItem(x)) : '<div class="data-empty">沒有未完成的待辦 🎉</div>'}
                ${this.section('已勾選（還在筆記裡，按 🧹 整理會收進紀錄）', d.todoDone.length, this.grouped(d.todoDone, x => this.todoItem(x)), { open: false, key: 'done' })}
                ${this.section('已整理收進工作紀錄', d.todoArchived.length, this.grouped(d.todoArchived, x => `<div class="ls-item done archived"><span>✅ ${this.esc(x.text)}</span><span class="ls-meta">${this.esc(x.date)}</span></div>`), { open: false, key: 'arch' })}`;
        } else if (U.tab === 'projects') {
            body = this.projectsTable();
        } else if (U.tab === 'cards') {
            body = this.cardsTable();
        } else if (U.tab === 'question') {
            body = d.qOpen.length ? this.grouped(d.qOpen, x => this.qItem(x, true)) : '<div class="data-empty">沒有待確認的問題。在卡片筆記按「❓ 問題」記下來。</div>';
        } else {
            body = `${d.qAnswered.length ? this.section('已回答（還在筆記裡）', d.qAnswered.length, this.grouped(d.qAnswered, x => this.qItem(x, true)), { key: 'ans' }) : ''}
                ${this.section('已整理收進工作紀錄', d.qArchived.length, this.grouped(d.qArchived, x => this.qItem(x, false)), { key: 'arch' })}
                ${!d.qAnswered.length && !d.qArchived.length ? '<div class="data-empty">還沒有回答過的問題。</div>' : ''}`;
        }
        target.innerHTML = `<div class="ls-wrap">
            <div class="ls-tabs">${tabs.map(([k, l]) => `<button type="button" class="ls-tab ${U.tab === k ? 'active' : ''}" onclick="app.lists.set('tab','${k}')">${l}</button>`).join('')}</div>
            <div class="ls-filters">
                <select onchange="app.lists.set('project', this.value)"><option value="">全部專案</option>${this.projects().map(p => `<option ${p === U.project ? 'selected' : ''}>${this.esc(p)}</option>`).join('')}</select>
                <input type="search" id="ls-search" placeholder="搜尋…" value="${this.esc(U.search)}" oninput="app.lists.ui.search=this.value; clearTimeout(app.lists._t); app.lists._t=setTimeout(()=>app.lists.render(),200)">
            </div>
            ${body}
        </div>`;
        if (keepSearch !== null) { const el = document.getElementById('ls-search'); el.focus(); el.selectionStart = el.selectionEnd = keepSearch; }
    },

    // ---------- 📁 專案表 ----------
    projectsTable() {
        const esc = x => this.esc(x), R = app.projectReg, W = app.worktime;
        const names = R.names();
        const cps = companyProjects();
        const showClosed = !!this.ui.showClosedProjects;
        const rows = names.map(n => {
            const cards = R.cardsOf(n).filter(({ card }) => !app.sync.isBlankCard(card));
            const open = cards.filter(({ card }) => Number(card.status) !== 2).length;
            const mins = cards.reduce((a, { card }) => a + W.totalMinutes(card), 0);
            return { n, p: R.get(n), open, total: cards.length, mins };
        }).filter(r => showClosed || r.p.status !== 'closed')
          .sort((a, b) => (a.p.status === 'closed') - (b.p.status === 'closed') || b.open - a.open || a.n.localeCompare(b.n, 'zh-Hant'));
        const closedN = names.filter(n => R.isClosed(n)).length;
        const row = r => `<div class="pj-row ${r.p.status === 'closed' ? 'closed' : ''}">
                <input class="pj-name" value="${esc(r.n)}" onchange="app.lists.renameProject(${esc(JSON.stringify(r.n))}, this.value)" onkeydown="if(event.key==='Enter' && !event.isComposing) this.blur()" title="改名＝所有卡片一起改">
                <select class="pj-company" onchange="app.lists.setProject(${esc(JSON.stringify(r.n))}, 'company', this.value)" title="公司工時表的標案">
                    <option value="">（公司標案）</option>${[...new Set([...cps, ...(r.p.company ? [r.p.company] : [])])].map(c => `<option value="${esc(c)}" ${c === r.p.company ? 'selected' : ''}>${esc(c.length > 26 ? c.slice(0, 26) + '…' : c)}</option>`).join('')}
                </select>
                <select class="pj-status" onchange="app.lists.setProject(${esc(JSON.stringify(r.n))}, 'status', this.value)"><option value="active" ${r.p.status !== 'closed' ? 'selected' : ''}>進行中</option><option value="closed" ${r.p.status === 'closed' ? 'selected' : ''}>已結案</option></select>
                <input class="pj-due" type="date" value="${esc(r.p.due || '')}" onchange="app.lists.setProject(${esc(JSON.stringify(r.n))}, 'due', this.value)" title="專案截止日">
                <span class="pj-stat">未完成 ${r.open}・共 ${r.total} 張${r.mins ? ` · ⏱ ${esc(W.formatMinutes(r.mins))}` : ''}</span>
                <span class="ct-actions">
                    <button type="button" onclick="app.lists.openProject(${esc(JSON.stringify(r.n))})" title="看這個專案的卡片">↗</button>
                    <button type="button" onclick="app.lists.mergeProject(${esc(JSON.stringify(r.n))})" title="合併到另一個專案（名字打錯、重複時用）">⇢</button>
                    ${r.total ? '' : `<button type="button" onclick="app.lists.removeProject(${esc(JSON.stringify(r.n))})" title="刪除這個專案（沒有卡片才能刪）">🗑</button>`}
                </span>
            </div>`;
        return `<div class="td-meta" style="margin-bottom:8px;">改專案名稱＝所有卡片一起改。設定「公司標案」後，AI 填公司工時表就照這個對。結案的專案，卡片不會再出現在今日頁（資料都還在）。</div>
            <div class="ct-table pj-table">
                <div class="pj-row ct-head"><span>專案</span><span>公司標案</span><span>狀態</span><span>截止日</span><span>卡片</span><span></span></div>
                ${rows.length ? rows.map(row).join('') : '<div class="data-empty">還沒有專案。在卡片的專案欄打名字就會出現在這裡。</div>'}
                <div class="pj-row ct-new"><input id="pj-new" placeholder="＋ 新增專案，打名字按 Enter" onkeydown="if(event.key==='Enter' && !event.isComposing) app.lists.addProject(this.value)"></div>
            </div>
            ${closedN ? `<label class="td-meta" style="display:block;margin-top:8px;"><input type="checkbox" ${showClosed ? 'checked' : ''} onchange="app.lists.ui.showClosedProjects=this.checked; app.lists.render()"> 顯示已結案的專案（${closedN}）</label>` : ''}`;
    },
    setProject(name, field, value) {
        app.projectReg.set(name, { [field]: value });
        if (field === 'status') { app.ui.toast(value === 'closed' ? `「${name}」已結案：卡片不再出現在今日頁` : `「${name}」恢復進行中`); this.render(); app.today?.renderSandbox?.(); }
    },
    renameProject(from, to) {
        const b = String(to || '').trim();
        if (!b) { this.render(); return; }
        if (app.projectReg.names().includes(b) && b !== from) { this.mergeProject(from, b); return; }
        const n = app.projectReg.rename(from, b);
        app.ui.defer(() => app.renderAll());
        app.ui.toast(`已改名，${n} 張卡片一起改成「${b}」`);
    },
    async mergeProject(from, preset = '') {
        const others = app.projectReg.names().filter(n => n !== from);
        if (!others.length) { app.ui.toast('沒有其他專案可以合併'); return; }
        this._mergeTo = preset && others.includes(preset) ? preset : others[0];
        const n = app.projectReg.cardsOf(from).length;
        const v = await app.ui.dialog({
            title: '合併專案',
            html: `<p>把「<b>${this.esc(from)}</b>」的 ${n} 張卡片改到：</p>
                <select class="task-meta-input" style="width:100%;" onchange="app.lists._mergeTo=this.value">${others.map(o => `<option value="${this.esc(o)}" ${o === this._mergeTo ? 'selected' : ''}>${this.esc(o)}</option>`).join('')}</select>
                <p class="pm-hint">「${this.esc(from)}」會從專案表移除。</p>`,
            buttons: [{ label: '取消', value: null }, { label: '合併', value: 'ok', primary: true }]
        });
        if (v !== 'ok') { this.render(); return; }
        const to = this._mergeTo;
        const moved = app.projectReg.rename(from, to);
        app.projectReg.remove(from);
        app.ui.defer(() => app.renderAll());
        app.ui.toast(`已合併：${moved} 張卡片改到「${to}」`);
    },
    removeProject(name) { app.projectReg.remove(name); this.render(); },
    addProject(value) {
        const n = String(value || '').trim();
        if (!n) return;
        app.projectReg.set(n, { status: 'active' });
        this.render();
        setTimeout(() => document.getElementById('pj-new')?.focus(), 0);
    },
    openProject(name) { this.ui.project = name; this.ui.tab = 'cards'; this.savePrefs(); this.render(); },

    // ---------- 🗂 卡片表 ----------
    cardRows() {
        const U = this.ui, W = app.worktime, q = U.search.trim().toLowerCase();
        const tabOrder = Object.fromEntries(app.state.tabs.map((t, i) => [t.id, i]));
        const rows = W.allCards().filter(({ card, tabId }) => {
            if (U.project && String(card.project || '').trim() !== U.project) return false;
            if (U.ctTab && tabId !== U.ctTab) return false;
            const st = Number(card.status) || 0;
            if (U.ctStatus === 'open' && st === 2) return false;
            if (/^\d$/.test(U.ctStatus) && st !== Number(U.ctStatus)) return false;
            return this.match(q, card.title, card.project, card.content);
        }).map(r => ({ ...r, end: r.card.isMemo ? '' : W.plannedEnd(r.card) }));
        const ts = c => Number(String(c.id).match(/(\d{10,})/)?.[1] || 0);
        rows.sort((a, b) => {
            if (U.ctSort === 'manual') {
                const oa = Number.isFinite(a.card.listOrder) ? a.card.listOrder : Infinity, ob = Number.isFinite(b.card.listOrder) ? b.card.listOrder : Infinity;
                if (oa !== ob) return oa - ob;
            }
            if (U.ctSort === 'recent') return ts(b.card) - ts(a.card);
            if (U.ctSort === 'ws' && a.tabId !== b.tabId) return (tabOrder[a.tabId] ?? 99) - (tabOrder[b.tabId] ?? 99);
            const da = Number(a.card.status) === 2, db = Number(b.card.status) === 2;
            if (da !== db) return da ? 1 : -1;
            if (!a.end !== !b.end) return a.end ? -1 : 1;
            return String(a.end).localeCompare(String(b.end)) || ts(b.card) - ts(a.card);
        });
        return rows;
    },

    cardsTable() {
        const U = this.ui, esc = x => this.esc(x), W = app.worktime;
        const tabs = app.state.tabs;
        const rows = this.cardRows();
        const statusOpts = [0, 1, 3, 2];
        const projects = this.projects();
        const row = ({ card, tabId, end }) => {
            const subs = app.sandbox.parseSubtasks(card.content);
            const doneN = subs.filter(x => x.completed).length;
            const openQ = app.questions.open(card).length;
            const mins = W.totalMinutes(card);
            const st = Number(card.status) || 0;
            const n = end ? app.sandbox.daysLeft(end) : null;
            const dueCls = st === 2 ? '' : (n === null ? '' : (n < 0 ? 'over' : (n <= 2 ? 'soon' : '')));
            return `<div class="ct-row ${st === 2 ? 'done' : ''}" data-id="${card.id}" ondragover="app.lists.dragOver(event, this)" ondragleave="this.classList.remove('drop-before','drop-after')" ondrop="app.lists.drop(event, this)">
                <span class="ct-handle" draggable="true" ondragstart="app.lists.dragStart(event, '${card.id}')" ondragend="app.lists.dragEnd()" title="拖曳排序（只影響清單，不動時間軸）">⋮⋮</span>
                <input class="ct-title" value="${esc(String(card.title || '').split('\n')[0])}" placeholder="未命名" onchange="app.lists.setField('${card.id}','title',this.value)" onkeydown="if(event.key==='Enter' && !event.isComposing) this.blur()" title="${esc(card.title || '')}">
                <select class="ct-ws" onchange="app.actions.moveCard('${card.id}', this.value)" title="工作區">${tabs.map(t => `<option value="${t.id}" ${t.id === tabId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
                <input class="ct-proj" value="${esc(card.project || '')}" placeholder="專案" autocomplete="off" onfocus="app.projectPicker.open(this)" onchange="app.lists.setField('${card.id}','project',this.value)" onkeydown="if(event.key==='Enter' && !event.isComposing) this.blur()">
                <select class="ct-type" onchange="app.today.setType('${card.id}', this.value)" title="任務類型"><option value="">—</option>${app.today.TYPE_ORDER.map(k => `<option value="${k}" ${k === card.taskType ? 'selected' : ''}>${app.today.TYPES[k].icon} ${app.today.TYPES[k].name}</option>`).join('')}</select>
                <select class="ct-status st-${st}" onchange="app.lists.setStatus('${card.id}', this.value)">${statusOpts.map(v => `<option value="${v}" ${v === st ? 'selected' : ''}>${esc(W.statusLabel(v))}</option>`).join('')}</select>
                <input class="ct-date ${dueCls}" type="date" value="${esc(end)}" onchange="app.lists.setDate('${card.id}', this.value)" title="${end ? '預計完成日（清空＝改回自由卡片）' : '選日期＝變成排程工項'}">
                <span class="ct-info">${card.docUrl ? `<a href="${esc(app.refs.href(card.docUrl))}" target="_blank" rel="noopener" title="Trello／文件：${esc(card.docUrl)}">📁</a>` : ''}${subs.length ? `<span title="待辦完成／全部">☑ ${doneN}/${subs.length}</span>` : ''}${openQ ? `<span title="未答問題">❓ ${openQ}</span>` : ''}${mins ? `<span title="已記工時">⏱ ${esc(W.formatMinutes(mins))}</span>` : ''}</span>
                <span class="ct-actions"><button type="button" class="ct-move" onclick="app.lists.moveBy('${card.id}',-1)" title="往上">▲</button><button type="button" class="ct-move" onclick="app.lists.moveBy('${card.id}',1)" title="往下">▼</button><button type="button" onclick="app.sandbox.focusTaskForTimer('${card.id}')" title="進心流專注這張卡">🎯</button><button type="button" onclick="app.actions.jumpToCard('${card.id}','${tabId}')" title="到時間軸看這張卡">↗</button><button type="button" onclick="app.actions.deleteCard('${card.id}','${tabId}')" title="刪除這張卡（可在「資料 → 最近刪除」救回）">🗑</button></span>
            </div>`;
        };
        const newTab = U.ctTab || app.state.activeTabId;
        return `<div class="ct-filters">
                <select onchange="app.lists.set('ctTab', this.value)"><option value="">全部工作區</option>${tabs.map(t => `<option value="${t.id}" ${t.id === U.ctTab ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
                <select onchange="app.lists.set('ctStatus', this.value)">${[['open', '未完成'], ['all', '全部狀態'], ['0', '未開始'], ['1', '進行中'], ['3', '卡住／等待'], ['2', '完成']].map(([v, l]) => `<option value="${v}" ${v === U.ctStatus ? 'selected' : ''}>${l}</option>`).join('')}</select>
                <select onchange="app.lists.set('ctSort', this.value)">${[['due', '依完成日'], ['recent', '最近新增'], ['ws', '依工作區'], ['manual', '自訂順序（拖曳）']].map(([v, l]) => `<option value="${v}" ${v === U.ctSort ? 'selected' : ''}>${l}</option>`).join('')}</select>
                <button type="button" class="bt-open" onclick="app.batch.open()" title="把卡片表交給 AI 批次補充、新增，貼回來逐筆勾選套用">🤖 AI 大表</button>
                ${app.batch.lastUndo() ? `<button type="button" class="bt-undo" onclick="app.batch.undo()" title="還原上一次 AI 大表套用的變更">↶ 復原上次 AI 大表</button>` : ''}
                <select onchange="app.lists.set('ctGroup', this.value)">${[['none', '不分組'], ['project', '依專案分組'], ['ws', '依工作區分組']].map(([v, l]) => `<option value="${v}" ${v === U.ctGroup ? 'selected' : ''}>${l}</option>`).join('')}</select>
            </div>
            <div class="ct-table">
                <div class="ct-row ct-head"><span></span><span>標題</span><span>工作區</span><span>專案</span><span>類型</span><span>狀態</span><span>預計完成</span><span>進度</span><span></span></div>
                ${!rows.length ? '<div class="data-empty">沒有符合的卡片。</div>' : (U.ctGroup === 'none' ? rows.map(row).join('') : this.groups(rows).map(g => {
                    const collapsed = !!U.ctCollapsed[`${U.ctGroup}:${g.key}`];
                    return `<div class="ct-group" data-group="${esc(g.key)}">
                        <button type="button" class="ct-group-head" onclick="app.lists.toggleGroup(${esc(JSON.stringify(g.key))})">${collapsed ? '▸' : '▾'} ${esc(g.label)} <span class="ls-count">${g.rows.length}</span></button>
                        ${collapsed ? '' : g.rows.map(row).join('') + `<div class="ct-row ct-new ct-group-new"><input class="ct-title" placeholder="＋ 新增到「${esc(g.label)}」" onkeydown="if(event.key==='Enter' && !event.isComposing) app.lists.addCardRow(this.value, ${esc(JSON.stringify(g.key))})"></div>`}
                    </div>`;
                }).join(''))}
                <div class="ct-row ct-new">
                    <input id="ct-new-title" class="ct-title" placeholder="＋ 新增卡片，打標題按 Enter" onkeydown="if(event.key==='Enter' && !event.isComposing) app.lists.addCardRow(this.value)">
                    <span class="ct-new-meta">加到「${esc(tabs.find(t => t.id === newTab)?.name || '')}」${U.project ? `・#${esc(U.project)}` : ''}</span>
                </div>
            </div>`;
    },

    NO_PROJECT: '__none__',
    groupKey(r) { return this.ui.ctGroup === 'ws' ? r.tabId : (String(r.card.project || '').trim() || this.NO_PROJECT); },
    groups(rows) {
        const U = this.ui, map = new Map();
        rows.forEach(r => { const k = this.groupKey(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); });
        const tabOrder = Object.fromEntries(app.state.tabs.map((t, i) => [t.id, i]));
        return [...map.entries()].map(([key, rs]) => ({
            key, rows: rs,
            label: U.ctGroup === 'ws' ? (app.state.tabs.find(t => t.id === key)?.name || '未知') : (key === this.NO_PROJECT ? '雜項（沒填專案）' : key)
        })).sort((a, b) => U.ctGroup === 'ws' ? (tabOrder[a.key] ?? 99) - (tabOrder[b.key] ?? 99)
            : (a.key === this.NO_PROJECT) - (b.key === this.NO_PROJECT) || a.label.localeCompare(b.label, 'zh-Hant'));
    },
    toggleGroup(key) {
        const k = `${this.ui.ctGroup}:${key}`;
        this.ui.ctCollapsed[k] = !this.ui.ctCollapsed[k];
        this.savePrefs();
        this.render();
    },

    // 畫面上目前的順序（分組時依組排）
    visibleOrder() {
        const rows = this.cardRows();
        return this.ui.ctGroup === 'none' ? rows : this.groups(rows).flatMap(g => g.rows);
    },
    applyOrder(ids) {
        ids.forEach((id, i) => { const c = app.worktime.getCard(id); if (c) c.listOrder = (i + 1) * 10; });
        const switched = this.ui.ctSort !== 'manual';
        this.ui.ctSort = 'manual';
        this.savePrefs();
        app.saveToLocal();
        this.render();
        if (switched) app.ui.toast('已改成「自訂順序」。只影響清單，時間軸的順序不變');
    },
    // 拖到別組：依專案分組＝改專案；依工作區分組＝移工作區
    regroup(cardId, groupKey) {
        const r = this.cardRows().find(x => x.card.id === cardId);
        if (!r || this.ui.ctGroup === 'none' || this.groupKey(r) === groupKey) return;
        if (this.ui.ctGroup === 'ws') { app.actions.moveCard(cardId, groupKey); return; }
        r.card.project = groupKey === this.NO_PROJECT ? '' : groupKey;
        app.refreshCard(cardId);
        app.ui.toast(`專案改成「${r.card.project || '雜項'}」`);
    },
    dragStart(e, id) {
        this._drag = id;
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', id); } catch (_) {}
        e.target.closest('.ct-row')?.classList.add('dragging');
    },
    dragEnd() { this._drag = null; document.querySelectorAll('.ct-row.dragging, .drop-before, .drop-after').forEach(el => el.classList.remove('dragging', 'drop-before', 'drop-after')); },
    dragOver(e, el) {
        if (!this._drag) return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        el.classList.toggle('drop-after', after);
        el.classList.toggle('drop-before', !after);
    },
    drop(e, el) {
        e.preventDefault();
        const from = this._drag, to = el.dataset.id;
        const after = el.classList.contains('drop-after');
        this.dragEnd();
        if (!from || !to || from === to) return;
        const group = el.closest('.ct-group')?.dataset.group;
        if (group !== undefined) this.regroup(from, group);
        const ids = this.visibleOrder().map(r => r.card.id).filter(id => id !== from);
        let i = ids.indexOf(to);
        if (i < 0) i = ids.length; else if (after) i += 1;
        ids.splice(i, 0, from);
        this.applyOrder(ids);
    },
    // 手機：▲▼（同一組內移動）
    moveBy(cardId, dir) {
        const order = this.visibleOrder();
        const idx = order.findIndex(r => r.card.id === cardId);
        const j = idx + dir;
        if (idx < 0 || j < 0 || j >= order.length) return;
        if (this.ui.ctGroup !== 'none' && this.groupKey(order[j]) !== this.groupKey(order[idx])) return;
        const ids = order.map(r => r.card.id);
        [ids[idx], ids[j]] = [ids[j], ids[idx]];
        this.applyOrder(ids);
    },

    setField(cardId, field, value) {
        const card = app.worktime.getCard(cardId);
        if (!card || !['title', 'project'].includes(field)) return;
        const v = String(value || '').trim();
        if (field === 'title' && String(card.title || '').includes('\n')) {
            const rest = String(card.title).split('\n').slice(1).join('\n');
            card.title = rest ? `${v}\n${rest}` : v;
        } else card[field] = v;
        app.saveToLocal();
        app.refreshCard(cardId);
        if (field === 'project' && this.ui.ctGroup === 'project') this.render();
    },

    setStatus(cardId, value) {
        const card = app.worktime.getCard(cardId);
        if (!card) return;
        const cur = Number(card.status) || 0, next = Number(value);
        if (next === 2) app.worktime.markCompleted(card);
        else {
            if (cur === 2) app.worktime.reopenCompleted(card, next);
            else card.status = next;
            if (next === 1) app.worktime.ensureStarted(card);
        }
        this.afterChange(cardId);
    },

    setDate(cardId, value) {
        const card = app.worktime.getCard(cardId);
        if (!card) return;
        if (!value) { card.isMemo = true; card.dateStart = ''; card.dateEnd = ''; card.dateMode = 'single'; }
        else {
            const start = card.isMemo ? '' : app.worktime.plannedStart(card);
            card.isMemo = false; card.dateMode = 'range'; card.dateEnd = value;
            card.dateStart = start && start <= value ? start : (value < app.worktime.localDateString() ? value : app.worktime.localDateString());
        }
        this.afterChange(cardId);
    },

    addCardRow(value, groupKey) {
        const title = String(value || '').trim();
        if (!title) return;
        const U = this.ui;
        let tabId = U.ctTab || app.state.activeTabId, project = U.project;
        if (groupKey !== undefined && U.ctGroup === 'ws') tabId = groupKey;
        if (groupKey !== undefined && U.ctGroup === 'project') project = groupKey === this.NO_PROJECT ? '' : groupKey;
        const card = app.quickAdd.create({ title, tabId, project });
        if (U.ctSort === 'manual') {
            const max = Math.max(0, ...app.worktime.allCards().map(r => Number.isFinite(r.card.listOrder) ? r.card.listOrder : 0));
            card.listOrder = max + 10;
        }
        app.saveToLocal();
        this.render();
        app.ui.toast(`已新增「${title}」`);
        setTimeout(() => {
            const sel = groupKey !== undefined ? `.ct-group[data-group="${CSS.escape(groupKey)}"] .ct-group-new input` : '#ct-new-title';
            document.querySelector(sel)?.focus();
        }, 0);
    },

    // 用行號＋文字確認是同一行（卡片在別處被改過時改用文字找）
    findLine(lines, lineIndex, test) {
        if (test(lines[lineIndex] ?? '')) return lineIndex;
        return lines.findIndex(test);
    },

    afterChange(cardId) {
        app.saveToLocal();
        app.refreshCard(cardId);
        const sb = app.state.sandbox;
        if (sb.activeTaskId === cardId) { const ta = document.getElementById('sb-activeNoteArea'); if (ta) ta.value = app.worktime.getCard(cardId).content; }
        this.render();
    },

    toggleTodo(cardId, lineIndex, text) {
        const card = app.worktime.getCard(cardId);
        if (!card) return;
        const lines = String(card.content || '').split('\n');
        const re = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
        const i = this.findLine(lines, lineIndex, l => { const m = l.match(re); return !!m && m[2] === text; });
        if (i < 0) { app.ui.toast('這張卡的筆記剛被改過，已重新整理清單', 'warn'); return this.render(); }
        app.sandbox.toggleSubtask(cardId, i);
        this.afterChange(cardId);
    },

    answer(cardId, line, qText, value) {
        const text = String(value || '').trim();
        if (!text) return;
        const card = app.worktime.getCard(cardId);
        if (!card) return;
        const lines = String(card.content || '').split('\n');
        const q = app.questions.parse(card.content).find(x => x.line === line && x.text === qText) || app.questions.parse(card.content).find(x => x.text === qText);
        if (!q) { app.ui.toast('找不到這個問題，可能剛被改過', 'warn'); return this.render(); }
        const empty = q.answerLines.find((li, k) => !q.answers[k]);
        if (empty !== undefined) lines[empty] = `${app.questions.A} ${text}`;
        else lines.splice(Math.max(q.line, ...q.answerLines) + 1, 0, `${app.questions.A} ${text}`);
        card.content = lines.join('\n');
        this.afterChange(cardId);
        app.ui.toast('已寫回卡片筆記');
    },

    complete(cardId) {
        const card = app.worktime.getCard(cardId);
        if (!card) return;
        app.worktime.markCompleted(card);
        this.afterChange(cardId);
        app.ui.toast(`✅「${this.cardTitle(card)}」標記完成。之後可以按 🧹 整理收進紀錄`);
    },

    add(value) {
        const text = String(value || '').trim();
        const cardId = document.getElementById('ls-add-card')?.value;
        const card = cardId ? app.worktime.getCard(cardId) : null;
        if (!text) return;
        if (!card) { app.ui.toast('先選要加到哪張卡', 'warn'); return; }
        const cur = String(card.content || '').replace(/\s+$/, '');
        card.content = `${cur}${cur ? '\n' : ''}- [ ] ${text}`;
        if (Number(card.status) === 2) app.worktime.reopenCompleted(card, 1);
        this.ui.addCard = cardId;
        this.afterChange(cardId);
        setTimeout(() => document.getElementById('ls-add-text')?.focus(), 0);
    }
};

// ==========================================
// 📥 貼上整理：整段貼進來，自動猜每一行是待辦／問題／回答，點標籤可改，再放進筆記
// ==========================================
app.pasteSort = {
    CYCLE: ['plain', 'todo', 'question', 'answer'],
    LABEL: { plain: '一般', todo: '✅ 待辦', question: '❓ 問題', answer: '💬 回答', done: '☑ 完成' },
    BULLET: /^\s*(?:[-*•・●▪◦]\s+|\d{1,2}[.)、．]\s*|[(（]\d{1,2}[)）]\s*|[一二三四五六七八九十]{1,2}[、.．]\s*)/,
    state: { text: '', overrides: {}, cardId: null },

    open(cardId) {
        this.state = { text: '', overrides: {}, cardId: cardId || null };
        const card = cardId ? app.worktime.getCard(cardId) : null;
        const where = card ? `「${app.entries.escapeHtml(String(card.title || '').trim().split('\n')[0] || '未命名')}」的筆記` : '全域草稿';
        app.ui.dialog({
            title: '📥 貼上整理',
            wide: true,
            html: `<p class="pm-hint" style="margin-top:0;">把會議記錄、訊息、AI 的回覆整段貼上，每一行前面的標籤點一下就換：一般 → 待辦 → 問題 → 回答。不想標也可以直接放進去。會放進${where}。</p>
                <textarea id="ps-input" class="ps-input" placeholder="貼在這裡…" oninput="app.pasteSort.onInput(this.value)"></textarea>
                <div id="ps-summary" class="ps-summary"></div>
                <div id="ps-preview" class="ps-preview"></div>`,
            buttons: [
                { label: '取消', value: null },
                { label: '原樣放進去', value: 'raw' },
                { label: '放進筆記', value: 'apply', primary: true }
            ]
        }).then(v => {
            if (!v || !this.state.text.trim()) return;
            const text = v === 'raw' ? this.state.text.replace(/\s+$/, '') : this.compose();
            this.put(this.state.cardId, text);
        });
        setTimeout(() => document.getElementById('ps-input')?.focus(), 30);
        this.render();
    },

    onInput(v) { this.state.text = v; this.state.overrides = {}; this.render(); },

    // 每一行：{ raw, body, kind, auto }
    analyze() {
        const out = [];
        let lastKind = null;
        String(this.state.text || '').replace(/\r/g, '').split('\n').forEach((raw, i) => {
            const t = raw.trim();
            const row = { i, raw: raw.replace(/\s+$/, ''), body: t, kind: 'plain' };
            if (!t) { row.kind = 'blank'; out.push(row); return; }
            let m;
            if ((m = t.match(/^[-*]\s+\[\s?\]\s*(.*)$/))) { row.kind = 'todo'; row.body = m[1]; }
            else if ((m = t.match(/^[-*]\s+\[[xX]\]\s*(.*)$/))) { row.kind = 'done'; row.body = m[1]; }
            else if ((m = t.match(/^[-*]\s+\[\?\]\s*(.*)$/) || t.match(/^❓️?\s*(.*)$/))) { row.kind = 'question'; row.body = m[1]; }
            else if ((m = t.match(/^[-*]\s+\[[aA]\]\s*(.*)$/) || t.match(/^💬\s*(.*)$/))) { row.kind = 'answer'; row.body = m[1]; }
            else if (/^\*\*\[\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}\]\*\*/.test(t) || /^#{1,6}\s/.test(t) || /^【.*】$/.test(t) || t === '---') { row.kind = 'plain'; }
            // 其他一律當「一般」，由自己點標籤決定
            row.auto = row.kind;
            const key = `${i}|${t}`;
            if (this.state.overrides[key]) row.kind = this.state.overrides[key];
            row.key = key;
            if (row.kind === 'plain' && row.auto !== 'plain') row.body = t; // 改回一般：保留原文
            if (row.auto === 'plain' && row.kind !== 'plain') row.body = t.replace(this.BULLET, '');
            out.push(row);
            lastKind = row.kind;
        });
        return out;
    },

    lineFor(r) {
        if (r.kind === 'blank') return '';
        if (r.kind === 'plain') return r.raw;
        const body = String(r.body || '').trim().replace(this.BULLET, '');
        return { todo: '- [ ] ', done: '- [x] ', question: '- [?] ', answer: '- [A] ' }[r.kind] + body;
    },

    compose() {
        return this.analyze().map(r => this.lineFor(r)).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '');
    },

    cycle(key) {
        const row = this.analyze().find(r => r.key === key);
        if (!row) return;
        const cur = this.CYCLE.indexOf(row.kind);
        this.state.overrides[key] = this.CYCLE[(cur + 1) % this.CYCLE.length];
        this.render();
    },

    setAll(kind) {
        this.analyze().forEach(r => { if (r.kind !== 'blank') this.state.overrides[r.key] = kind; });
        this.render();
    },

    render() {
        const prev = document.getElementById('ps-preview');
        const sum = document.getElementById('ps-summary');
        if (!prev || !sum) return;
        const esc = x => app.entries.escapeHtml(x);
        const rows = this.analyze();
        const filled = rows.filter(r => r.kind !== 'blank');
        if (!filled.length) { prev.innerHTML = ''; sum.innerHTML = ''; return; }
        const count = k => filled.filter(r => r.kind === k).length;
        const parts = [['todo', '待辦'], ['question', '問題'], ['answer', '回答'], ['done', '已完成']].filter(([k]) => count(k)).map(([k, n]) => `${count(k)} ${n}`);
        sum.innerHTML = `<span>${parts.length ? parts.join('・') : '還沒標'}，共 ${filled.length} 行</span>
            <span><button type="button" class="ps-mini" onclick="app.pasteSort.setAll('plain')">全部當一般</button></span>`;
        prev.innerHTML = rows.map(r => r.kind === 'blank' ? '<div class="ps-row ps-blank"></div>' : `<div class="ps-row">
                <button type="button" class="ps-chip ps-${r.kind}" onclick="app.pasteSort.cycle(${esc(JSON.stringify(r.key))})" title="點一下換類型">${this.LABEL[r.kind]}</button>
                <span class="ps-text ${r.kind === 'plain' ? 'plain' : ''}">${esc(r.kind === 'plain' ? r.raw.trim() : String(r.body || '').replace(this.BULLET, ''))}</span>
            </div>`).join('');
    },

    put(cardId, text) {
        if (!text) return;
        const sb = app.state.sandbox;
        if (app.state.view === 'sandbox' && (sb.activeTaskId || null) === cardId) {
            app.sandbox.insertBlock(text);
        } else {
            const card = cardId ? app.worktime.getCard(cardId) : null;
            if (!card) return;
            const cur = String(card.content || '').replace(/\s+$/, '');
            card.content = cur ? `${cur}\n${text}` : text;
            app.saveToLocal();
            app.refreshCard(cardId);
        }
        const n = text.split('\n').filter(l => /^- \[[ x?A]\]/.test(l)).length;
        app.ui.toast(n ? `已放進筆記（${n} 行有標記）` : '已放進筆記');
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
        // 今日、卡片、心流有自己的列表，開在這些頁面時先不打開導覽
        this.ui.open = this.defaultOpen() && !['today', 'lists', 'sandbox'].includes(app.state.view);
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
        this.ui.userClosed = !this.ui.open;
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
        if (app.state.view === 'sandbox') {
            // 在心流沙盒裡：切換專注的卡片，不離開心流
            if (tabId && tabId !== app.state.activeTabId && app.state.workspaces[tabId]) {
                app.state.activeTabId = tabId;
                app.state.filters.activeProject = null;
                app.rememberPrefs();
                app.renderTabs();
            }
            app.sandbox.setActiveTask(cardId);
            this.setActiveCard(cardId);
            if (this.isMobile()) this.close();
            const card = app.worktime.getCard(cardId);
            app.ui.toast(`🎯 專注在「${String(card?.title || '').trim() || '未命名'}」`);
            return;
        }
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
