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

// === 核心 App 邏輯 ===
const app = {
    currentUser: null,
    state: {
        tabs: [{ id: 'main', name: '主工作區' }],
        activeTabId: 'main',
        workspaces: { 'main': [] },
        nodes: { 'main': [] }, 
        globalNotebook: { template: 'free', free: '', matrix: { q1:'', q2:'', q3:'', q4:'' } },
        tsumego: { isOpen: false, currentColor: 'black', stones: [] },
        view: 'timeline',
        filters: { keyword: '', activeProject: null },
        ganttFilters: { project: '', month: '', mode: 'schedule', scale: '' },
        chronicleFilters: { scope: 'all', project: '' },
        showProjectBar: false,
        
        // SPA 沙盒專屬狀態
        sandbox: {
            activeTaskId: null,
            mode: 'FLEXIBLE', timerStatus: 'IDLE', seconds: 0,
            pomoPhase: 'FOCUS', pomoCount: 0, timerInterval: null,
            // 以下為執行期計時狀態，不寫入 Firebase / localStorage 設定。
            timerTaskId: null, timerSessionSeconds: 0, timerSessionStartedAt: null,
            deadlineTask: '', deadlineDate: ''
        }
    },

    // 工作紀錄的畫面狀態只存在記憶體，不寫入 localStorage / Firebase。
    // 真正資料只放在 card.entries，避免改動既有同步結構。
    entryUi: {},

    init() {
        auth.onAuthStateChanged((user) => {
            if (user) {
                this.currentUser = user;
                document.getElementById('login-screen').style.display = 'none';
                document.getElementById('app-content').style.display = 'block';
                this.injectStarPoints(); 
                this.loadFromLocal();
                this.setupMatrixDrag();
                this.setupTsumegoDrag();
                this.fetchCloudTime();
                this.sandbox.initUI();
            } else {
                this.currentUser = null;
                document.getElementById('login-screen').style.display = 'flex';
                document.getElementById('app-content').style.display = 'none';
            }
        });
    },

    login() { auth.signInWithPopup(provider).catch(err => alert("登入失敗: " + err.message)); },
    logout() { if(confirm('確定登出？若不想留暫存請先點擊「🧹 清本機」')) auth.signOut(); },

    saveToLocal() {
        const dataToSave = {
            tabs: this.state.tabs, workspaces: this.state.workspaces, nodes: this.state.nodes, 
            globalNotebook: this.state.globalNotebook, tsumego: { stones: this.state.tsumego.stones },
            sandbox: { deadlineTask: this.state.sandbox.deadlineTask, deadlineDate: this.state.sandbox.deadlineDate }
        };
        localStorage.setItem(`whiteboard_state_${this.currentUser.uid}`, JSON.stringify(dataToSave));
        const statusEl = document.getElementById('local-save-status');
        if(statusEl) { statusEl.innerText = '💾 儲存中...'; setTimeout(() => { statusEl.innerText = '✅ 已存於本機'; }, 500); }
    },

    loadFromLocal() {
        const localData = localStorage.getItem(`whiteboard_state_${this.currentUser.uid}`);
        if (localData) {
            const data = JSON.parse(localData);
            this.state.tabs = data.tabs || [{ id: 'main', name: '主工作區' }];
            this.state.workspaces = data.workspaces || { 'main': [] };
            this.state.nodes = data.nodes || { 'main': [] };
            this.state.globalNotebook = data.globalNotebook || { template: 'free', free: '', matrix: {} };
            if(data.tsumego && data.tsumego.stones) this.state.tsumego.stones = data.tsumego.stones;
            if(data.sandbox) {
                this.state.sandbox.deadlineTask = data.sandbox.deadlineTask || '';
                this.state.sandbox.deadlineDate = data.sandbox.deadlineDate || '';
                if(document.getElementById('sb-deadlineTask')) document.getElementById('sb-deadlineTask').value = this.state.sandbox.deadlineTask;
                if(document.getElementById('sb-deadlineDate')) document.getElementById('sb-deadlineDate').value = this.state.sandbox.deadlineDate;
                this.sandbox.updateCountdown();
            }
            if (!this.state.nodes[this.state.activeTabId]) this.state.nodes[this.state.activeTabId] = [];
            this.renderAll(); this.renderTsumegoStones();
        } else {
            if(confirm("本機沒有暫存資料。是否要從雲端下載最新進度？")) this.loadFromCloudManual(); else this.renderAll();
        }
    },

    clearLocalData() {
        if(!confirm("⚠️ 警告：徹底清除「這台裝置」上的所有暫存進度！確定嗎？")) return;
        localStorage.removeItem(`whiteboard_state_${this.currentUser.uid}`);
        this.state.tabs = [{ id: 'main', name: '主工作區' }]; this.state.activeTabId = 'main';
        this.state.workspaces = { 'main': [] }; this.state.nodes = { 'main': [] };
        this.state.tsumego.stones = [];
        this.renderAll(); this.renderTsumegoStones(); alert("🧹 本機資料已清空！");
    },

    saveToCloudManual() {
        const btn = document.querySelector('.btn-cloud-save'); const orig = btn.innerText; btn.innerText = "上傳中...";
        const payload = { tabs: this.state.tabs, workspaces: this.state.workspaces, nodes: this.state.nodes, globalNotebook: this.state.globalNotebook, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
        db.collection('Whiteboard_Data').doc(this.currentUser.uid).set(payload, { merge: true }).then(() => {
            alert("✅ 備份至雲端。"); this.fetchCloudTime(); 
        }).catch(err => alert("失敗：" + err.message)).finally(() => btn.innerText = orig);
    },

    loadFromCloudManual() {
        if(!confirm("⚠️ 將覆蓋目前畫面上所有資料。確定繼續？")) return;
        const btn = document.querySelector('.btn-cloud-load'); const orig = btn.innerText; btn.innerText = "下載中...";
        db.collection('Whiteboard_Data').doc(this.currentUser.uid).get().then((doc) => {
            if (doc.exists) {
                const data = doc.data();
                this.state.tabs = data.tabs || [{ id: 'main', name: '主工作區' }]; this.state.workspaces = data.workspaces || { 'main': [] }; this.state.nodes = data.nodes || { 'main': [] };
                this.state.globalNotebook = data.globalNotebook || { template: 'free', free: '', matrix: {} };
                if (!this.state.tabs.find(t => t.id === this.state.activeTabId)) this.state.activeTabId = this.state.tabs[0].id;
                if (!this.state.nodes[this.state.activeTabId]) this.state.nodes[this.state.activeTabId] = [];
                this.saveToLocal(); this.renderAll(); this.fetchCloudTime(); alert("📥 載入成功！");
            } else { alert("雲端目前沒有備份資料喔！"); }
        }).catch(err => alert("下載失敗：" + err.message)).finally(() => btn.innerText = orig);
    },

    fetchCloudTime() {
        db.collection('Whiteboard_Data').doc(this.currentUser.uid).get().then(doc => {
            const displayEl = document.getElementById('cloud-time-display');
            if (doc.exists && doc.data().updatedAt) {
                const d = doc.data().updatedAt.toDate();
                displayEl.innerText = `☁️ 雲端: ${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
                displayEl.style.display = 'inline-block';
            }
        }).catch(err => console.log("無法取得雲端時間", err));
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
                    expanded: source !== 'sandbox'
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

            if (source === 'sandbox' && !ui.expanded) {
                const latest = entries[0];
                return `
                    <div class="worklog-collapsed" onclick="app.entries.toggleExpanded('${card.id}', 'sandbox')">
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
                        ${source === 'sandbox' ? `<button class="worklog-action-btn" onclick="app.entries.toggleExpanded('${card.id}', 'sandbox')">收合</button>` : ''}
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
                        <div class="worklog-heading" style="justify-content:flex-end;">${source === 'sandbox' ? `<button class="worklog-action-btn" onclick="app.entries.toggleExpanded('${card.id}', 'sandbox')">收合</button>` : ''}</div>
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
                        ${source === 'sandbox' ? `<button class="worklog-action-btn" onclick="app.entries.toggleExpanded('${card.id}', 'sandbox')">收合</button>` : ''}
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
            if (source === 'sandbox') ui.expanded = true;
            this.refresh(cardId, source);
            setTimeout(() => document.getElementById(`worklog-title-${source}-${cardId}`)?.focus(), 0);
        },

        openEntry(cardId, entryId, source = 'timeline') {
            const ui = this.getUi(cardId, source);
            ui.mode = 'detail';
            ui.selectedId = entryId;
            ui.editingId = null;
            if (source === 'sandbox') ui.expanded = true;
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
            return (typeof window !== 'undefined' && window.innerWidth <= 768) ? 'week' : 'day';
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
            if (!this.planningUi[key]) this.planningUi[key] = { expanded: false };
            return this.planningUi[key];
        },

        togglePlanning(cardId, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card) return;
            const ui = this.getPlanningUi(cardId, source);
            ui.expanded = !ui.expanded;
            if (source === 'sandbox') {
                app.entries.renderSandbox(card);
                return;
            }
            const panel = document.getElementById(`task-meta-${source}-${cardId}`);
            if (panel) panel.outerHTML = this.renderPlanningPanel(card, source);
        },

        renderPlanningPanel(card, source = 'timeline') {
            const esc = app.entries.escapeHtml.bind(app.entries);
            const category = esc(card.category || '');
            const planned = this.plannedParts(card);
            const progress = this.progressValue(card, true);
            const deliverable = esc(card.deliverable || '');
            const acceptance = esc(card.acceptance || '');
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
            const ui = this.getPlanningUi(card.id, source);
            const collapsedSummary = `${isScheduled ? '排程工項' : '自由卡'} · 預估 ${this.plannedMinutes(card) ? this.formatMinutes(this.plannedMinutes(card)) : '未填'} · 實際 ${this.formatMinutes(actualMinutes)}`;

            if (!ui.expanded) {
                return `
                    <div class="task-meta-panel task-meta-collapsed" id="task-meta-${source}-${card.id}">
                        <button class="pm-collapse-toggle" type="button" onclick="app.worktime.togglePlanning('${card.id}','${source}')" aria-expanded="false">
                            <span class="pm-collapse-title">📐 規劃 / ✅ 實際</span>
                            <span class="pm-collapse-summary">${esc(collapsedSummary)}</span>
                            <span class="pm-collapse-icon">展開 ▾</span>
                        </button>
                    </div>`;
            }

            return `
                <div class="task-meta-panel" id="task-meta-${source}-${card.id}">
                    <button class="pm-collapse-toggle pm-collapse-toggle-open" type="button" onclick="app.worktime.togglePlanning('${card.id}','${source}')" aria-expanded="true">
                        <span class="pm-collapse-title">📐 規劃 / ✅ 實際</span>
                        <span class="pm-collapse-summary">${esc(collapsedSummary)}</span>
                        <span class="pm-collapse-icon">收合 ▴</span>
                    </button>
                    <div class="pm-section pm-section-plan">
                        <div class="pm-section-title">
                            <span>📐 規劃</span>
                            <span class="pm-summary">預估 ${this.plannedMinutes(card) ? this.formatMinutes(this.plannedMinutes(card)) : '未填'} · ${planStart || '未排'}${planEnd && planEnd !== planStart ? ` → ${planEnd}` : ''}</span>
                        </div>
                        <div class="pm-section-body">
                            <div class="task-meta-grid">
                                <label class="task-meta-field">
                                    <span class="task-meta-label">卡片用途</span>
                                    <select class="task-meta-input" onchange="app.worktime.updateCardMode('${card.id}',this.value,'${source}')">
                                        <option value="free" ${!isScheduled ? 'selected' : ''}>自由卡（不進甘特／工項 Excel）</option>
                                        <option value="scheduled" ${isScheduled ? 'selected' : ''}>排程工項</option>
                                    </select>
                                </label>
                                <label class="task-meta-field" title="工作包（Work Package）就是同一專案中可一起管理的一組相關工作。這裡當作任務分類使用，可留白。">
                                    <span class="task-meta-label">任務分類 <span style="font-weight:normal;color:#94a3b8;">（工作包，可留白）</span></span>
                                    <input class="task-meta-input" value="${category}" placeholder="例如：圖表處理、目錄處理" onchange="app.worktime.updateCardField('${card.id}','category',this.value,'${source}')">
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">任務標記</span>
                                    <span class="color-select-wrap">
                                        <span class="color-chip" style="background:${colorCfg.hex}"></span>
                                        <select class="task-meta-input" onchange="app.worktime.updateCardField('${card.id}','color',this.value,'${source}')">
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
                                    <span class="task-meta-label">預計開始</span>
                                    <input class="task-meta-input" type="date" value="${planStart}" onchange="app.worktime.updatePlannedDate('${card.id}','start',this.value,'${source}')">
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">預計完成</span>
                                    <input class="task-meta-input" type="date" value="${planEnd}" onchange="app.worktime.updatePlannedDate('${card.id}','end',this.value,'${source}')">
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">預估工時</span>
                                    <span class="duration-grid">
                                        <input class="task-meta-input" type="number" min="0" step="1" value="${planned.hours || ''}" placeholder="小時" onchange="app.worktime.updatePlannedPart('${card.id}','hours',this.value,'${source}')">
                                        <input class="task-meta-input" type="number" min="0" step="1" value="${planned.minutes || ''}" placeholder="分鐘" onchange="app.worktime.updatePlannedPart('${card.id}','minutes',this.value,'${source}')">
                                    </span>
                                </label>
                            </div>
                            <div class="task-meta-grid" style="margin-top:8px;grid-template-columns:120px 1fr 1fr;">
                                <label class="task-meta-field">
                                    <span class="task-meta-label">進度（%）</span>
                                    <input class="task-meta-input" type="number" min="0" max="100" step="5" value="${progress}" placeholder="0-100" onchange="app.worktime.updateCardField('${card.id}','progress',this.value,'${source}',true)">
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">預期產出</span>
                                    <textarea class="task-meta-textarea" placeholder="做完會得到什麼" onchange="app.worktime.updateCardField('${card.id}','deliverable',this.value,'${source}')">${deliverable}</textarea>
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">驗收條件</span>
                                    <textarea class="task-meta-textarea" placeholder="怎樣算完成" onchange="app.worktime.updateCardField('${card.id}','acceptance',this.value,'${source}')">${acceptance}</textarea>
                                </label>
                            </div>
                        </div>
                    </div>

                    <div class="pm-section pm-section-actual">
                        <div class="pm-section-title">
                            <span>✅ 實際</span>
                            <span class="pm-summary">已投入 ${this.formatMinutes(actualMinutes)} · <span class="${varianceClass}">${this.formatVariance(card)}</span></span>
                        </div>
                        <div class="pm-section-body">
                            <div class="task-meta-grid">
                                <label class="task-meta-field">
                                    <span class="task-meta-label">實際開始</span>
                                    <input class="task-meta-input" type="date" value="${actualStart}" onchange="app.worktime.updateCardField('${card.id}','actualStart',this.value,'${source}')">
                                </label>
                                <label class="task-meta-field">
                                    <span class="task-meta-label">實際完成</span>
                                    <input class="task-meta-input" type="date" value="${actualEnd}" onchange="app.worktime.updateCardField('${card.id}','actualEnd',this.value,'${source}')">
                                </label>
                                <div class="actual-metric">
                                    <span class="task-meta-label">實際工時（由紀錄加總）</span>
                                    <strong>${this.formatMinutes(actualMinutes)}</strong>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>`;
        },

        renderPanel(card, source = 'timeline') {
            const esc = app.entries.escapeHtml.bind(app.entries);
            const logs = [...this.getLogs(card)].sort((a,b) => {
                const da = `${a.workDate || ''} ${a.createdAt || ''}`;
                const db = `${b.workDate || ''} ${b.createdAt || ''}`;
                return db.localeCompare(da);
            });
            const total = this.totalMinutes(card);
            const planned = this.plannedMinutes(card);
            const plannedText = planned > 0 ? ` / 預估 ${this.formatMinutes(planned)}` : '';
            const defaultDate = this.localDateString();
            const rows = logs.length ? logs.slice(0, 30).map(log => `
                <div class="worktime-row">
                    <span>${esc(log.workDate || '')}</span>
                    <strong>${this.formatMinutes(this.logMinutes(log))}</strong>
                    <span class="worktime-row-note" title="${esc(log.note || '')}">${esc(log.note || (log.source === 'timer' ? '心流計時' : '手動補登'))} <span class="worktime-source">${log.source === 'timer' ? '· 計時' : '· 手動'}</span></span>
                    <button class="worktime-edit" title="修改此筆工時" onclick="app.worktime.editLog('${card.id}','${log.id}','${source}')">✏️</button>
                    <button class="worktime-delete" title="刪除此筆工時" onclick="app.worktime.deleteLog('${card.id}','${log.id}','${source}')">×</button>
                </div>`).join('') : `<div class="worktime-empty">尚無工時紀錄。心流計時停止後會自動寫入，也可手動補登分鐘或小時。</div>`;

            return `
                <div class="worktime-panel" id="worktime-panel-${source}-${card.id}">
                    <div class="worktime-header">
                        <span style="font-weight:bold;color:#475569;">⏱️ 工時明細</span>
                        <span class="worktime-total">實際 ${this.formatMinutes(total)}${plannedText}</span>
                    </div>
                    <div class="worktime-form">
                        <label class="task-meta-field">
                            <span class="task-meta-label">日期</span>
                            <input id="worktime-date-${source}-${card.id}" class="worktime-input" type="date" value="${defaultDate}">
                        </label>
                        <label class="task-meta-field">
                            <span class="task-meta-label">小時</span>
                            <input id="worktime-hours-${source}-${card.id}" class="worktime-input" type="number" min="0" step="0.25" placeholder="1.5">
                        </label>
                        <label class="task-meta-field">
                            <span class="task-meta-label">分鐘</span>
                            <input id="worktime-minutes-${source}-${card.id}" class="worktime-input" type="number" min="0" step="1" placeholder="30">
                        </label>
                        <label class="task-meta-field worktime-note-field">
                            <span class="task-meta-label">工作內容</span>
                            <input id="worktime-note-${source}-${card.id}" class="worktime-input" type="text" placeholder="例如：圖表定位規則測試">
                        </label>
                        <button class="worklog-add-btn" onclick="app.worktime.addManual('${card.id}','${source}')">＋ 補登</button>
                    </div>
                    <div class="worktime-list">${rows}</div>
                </div>`;
        },

        refresh(cardId, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card) return;
            if (source === 'sandbox') {
                app.entries.renderSandbox(card);
                return;
            }
            const p = document.getElementById(`task-meta-${source}-${cardId}`);
            if (p) p.outerHTML = this.renderPlanningPanel(card, source);
            const w = document.getElementById(`worktime-panel-${source}-${cardId}`);
            if (w) w.outerHTML = this.renderPanel(card, source);
        },

        updateCardField(cardId, field, value, source = 'timeline', numeric = false) {
            const card = this.getCard(cardId);
            if (!card) return;
            if (numeric) {
                if (String(value).trim() === '') delete card[field];
                else card[field] = Number(value);
            } else {
                if (value === '' && (field === 'actualStart' || field === 'actualEnd')) delete card[field];
                else card[field] = value;
            }
            app.saveToLocal();
            if (field === 'color') app.renderAll();
            else this.refresh(cardId, source);
            if (app.state.view === 'gantt') app.renderGantt();
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
            app.renderAll();
            if (source === 'sandbox') app.entries.renderSandbox(card);
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
            app.renderAll();
            if (source === 'sandbox') app.entries.renderSandbox(card);
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
            if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return alert('請輸入工時。小時、分鐘可擇一填寫，也可以一起填。');
            if (!Array.isArray(card.workLogs)) card.workLogs = [];
            const now = new Date().toISOString();
            const workDate = dateEl?.value || this.localDateString();
            card.workLogs.push({
                id: `work_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
                workDate,
                minutes: totalMinutes,
                note: noteEl?.value.trim() || '手動補登',
                source: 'manual', createdAt: now, updatedAt: now
            });
            this.ensureActualStart(card, workDate);
            app.saveToLocal();
            this.refresh(cardId, source);
            app.sandbox.renderTodo();
            if (app.state.view === 'gantt') app.renderGantt();
        },

        addTimerLog(cardId, seconds, note = '心流計時') {
            const card = this.getCard(cardId);
            const sec = Math.round(Number(seconds) || 0);
            if (!card || sec <= 0) return false;
            if (!Array.isArray(card.workLogs)) card.workLogs = [];
            const now = new Date().toISOString();
            const workDate = this.localDateString();
            card.workLogs.push({
                id: `work_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
                workDate,
                minutes: Math.round((sec / 60) * 100) / 100,
                seconds: sec,
                note,
                source: 'timer', createdAt: now, updatedAt: now
            });
            this.ensureActualStart(card, workDate);
            app.saveToLocal();
            return true;
        },

        editLog(cardId, logId, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card) return;
            const log = this.getLogs(card).find(l => l.id === logId);
            if (!log) return;
            const currentMins = Math.round(this.logMinutes(log));
            const curHours = Math.floor(currentMins / 60);
            const curMinutes = currentMins % 60;
            const date = prompt('工作日期（YYYY-MM-DD）', log.workDate || this.localDateString());
            if (date === null) return;
            const hoursRaw = prompt('小時（可填 0；例如 1.5）', String(curHours));
            if (hoursRaw === null) return;
            const minutesRaw = prompt('分鐘（可填 0，也可直接填 90）', String(curMinutes));
            if (minutesRaw === null) return;
            const hours = Math.max(0, Number(hoursRaw) || 0);
            const minutes = Math.max(0, Number(minutesRaw) || 0);
            const totalMinutes = Math.round((hours * 60 + minutes) * 100) / 100;
            if (totalMinutes <= 0) return alert('工時必須大於 0。');
            const note = prompt('工作內容', log.note || '') ;
            if (note === null) return;
            log.workDate = date || this.localDateString();
            log.minutes = totalMinutes;
            delete log.hours;
            delete log.seconds;
            log.note = note.trim() || (log.source === 'timer' ? '心流計時' : '手動補登');
            log.updatedAt = new Date().toISOString();
            this.ensureActualStart(card, log.workDate);
            app.saveToLocal();
            this.refresh(cardId, source);
            app.sandbox.renderTodo();
            if (app.state.view === 'gantt') app.renderGantt();
        },

        deleteLog(cardId, logId, source = 'timeline') {
            const card = this.getCard(cardId);
            if (!card || !Array.isArray(card.workLogs)) return;
            const log = card.workLogs.find(l => l.id === logId);
            if (!log) return;
            if (!confirm(`刪除這筆 ${this.formatMinutes(this.logMinutes(log))} 的工時紀錄？`)) return;
            card.workLogs = card.workLogs.filter(l => l.id !== logId);
            app.saveToLocal();
            this.refresh(cardId, source);
            app.sandbox.renderTodo();
            if (app.state.view === 'gantt') app.renderGantt();
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

        ganttCards() {
            return this.scheduledCards().filter(({card}) => card.dateMode === 'range' && card.dateStart && card.dateEnd);
        },

        taskExportRows() {
            return this.scheduledCards().map(({card, tabName}) => {
                const planned = this.plannedMinutes(card);
                const actual = this.totalMinutes(card);
                const variance = planned ? Math.round(actual - planned) : '';
                const progress = this.progressValue(card, true);
                return [
                    tabName, card.project||'', card.category||'', card.title||'', this.colorConfig(card.color).label,
                    this.statusLabel(card.status), progress === '' ? '' : progress,
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
            return this.ganttCards().map(({card, tabName}) => [
                tabName, card.project||'', card.category||'', card.title||'', this.colorConfig(card.color).label,
                this.statusLabel(card.status), this.progressValue(card, true), card.dateStart||'', card.dateEnd||'',
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
                alert(successMessage);
            };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(() => alert(successMessage)).catch(fallback);
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
            app.renderGantt();
        },

        setGanttScale(scale) {
            if (!app.state.ganttFilters) app.state.ganttFilters = { project:'', month:'', mode:'schedule', scale:'' };
            if (!['day','week','month'].includes(scale)) return;
            app.state.ganttFilters.scale = scale;
            app.renderGantt();
        },

        resetGanttFilters() {
            const mode = app.state.ganttFilters?.mode === 'time' ? 'time' : 'schedule';
            const scale = this.getGanttScale();
            app.state.ganttFilters = { project:'', month:'', mode, scale };
            app.renderGantt();
        },

        copyTasksToExcel() {
            const header = ['分頁','專案','分類','工項','標記','狀態','進度(%)','預計開始','預計完成','預估工時(分鐘)','預估工時(小時)','實際開始','實際完成','實際工時(分鐘)','實際工時(小時)','工時差異(分鐘)','預期產出','驗收條件','卡片ID'];
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
            const header = ['分頁','專案','分類','工項','標記','狀態','進度(%)','預計開始','預計完成','預估工時(分鐘)','實際工時(分鐘)','實際開始','實際完成','卡片ID'];
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
                const taskHeader = ['分頁','專案','分類','工項','標記','狀態','進度(%)','預計開始','預計完成','預估工時(分鐘)','預估工時(小時)','實際開始','實際完成','實際工時(分鐘)','實際工時(小時)','工時差異(分鐘)','預期產出','驗收條件','卡片ID'];
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
                taskSheet.autoFilter = { from:'A1', to:'S1' };
                [12,16,16,28,18,14,10,13,13,16,16,13,13,16,16,18,30,30,26].forEach((w,i)=>taskSheet.getColumn(i+1).width=w);
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
                    const ga = `${a.card.project||''} ${a.card.category||''}`;
                    const gb = `${b.card.project||''} ${b.card.category||''}`;
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
        
        initUI() {
            this.updateDisplay();
            const textarea = document.getElementById('sb-activeNoteArea');
            if(textarea) {
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

        parseSubtasks(content) {
            if (!content) return [];
            const lines = content.split('\n');
            const subtasks = [];
            const regex = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
            lines.forEach((line, index) => {
                const match = line.match(regex);
                if (match) {
                    subtasks.push({
                        lineIndex: index,
                        completed: match[1].toLowerCase() === 'x',
                        text: match[2],
                        raw: line
                    });
                }
            });
            return subtasks;
        },

        toggleSubtask(cardId, lineIndex) {
            const card = this.getActiveCards().find(c => c.id === cardId);
            if (!card) return;
            const lines = card.content.split('\n');
            const line = lines[lineIndex];
            
            if (line.includes('[ ]')) {
                lines[lineIndex] = line.replace('[ ]', '[x]');
            } else if (line.includes('[x]') || line.includes('[X]')) {
                lines[lineIndex] = line.replace(/\[x\]/i, '[ ]');
            }
            card.content = lines.join('\n');
            
            const subtasks = this.parseSubtasks(card.content);
            if (subtasks.length > 0 && subtasks.every(st => st.completed)) {
                card.status = 2;
                const today = app.worktime.localDateString();
                if (!card.actualStart) card.actualStart = today;
                if (!card.actualEnd) card.actualEnd = today;
                if (card.progress === undefined || card.progress === null || card.progress === '') card.progress = 100;
            } else if (subtasks.length > 0 && subtasks.some(st => !st.completed) && card.status === 2) {
                card.status = 0;
            }
            
            app.saveToLocal();
            this.renderTodo();
            if (app.state.sandbox.activeTaskId === cardId) {
                document.getElementById('sb-activeNoteArea').value = card.content;
            }
        },

        addTodo() {
            const input = document.getElementById('sb-newTodoTask');
            const text = input.value.trim();
            if (!text) return;

            let targetCardId = app.state.sandbox.activeTaskId;
            let targetCard = null;

            if (targetCardId) {
                targetCard = this.getActiveCards().find(c => c.id === targetCardId);
                if (targetCard) {
                    const prefix = targetCard.content && !targetCard.content.endsWith('\n') ? '\n' : '';
                    targetCard.content += `${prefix}- [ ] ${text}\n`;
                    if (targetCard.status === 2) targetCard.status = 0; 
                }
            } 
            
            if (!targetCard) {
                targetCard = this.getActiveCards().find(c => c.title === '今日雜項');
                if (!targetCard) {
                    targetCard = { 
                        id: 'card_' + Date.now(), title: '今日雜項', content: '', project: '日常', 
                        dateMode: 'single', dateSingle: new Date().toISOString().split('T')[0], 
                        color: 'blue', status: 0, isMemo: false 
                    };
                    app.state.workspaces[app.state.activeTabId].unshift(targetCard);
                }
                app.state.sandbox.activeTaskId = targetCard.id;
                const prefix = targetCard.content && !targetCard.content.endsWith('\n') ? '\n' : '';
                targetCard.content += `${prefix}- [ ] ${text}\n`;
            }

            input.value = '';
            app.saveToLocal();
            this.renderTodo();
            this.refreshActiveNoteUI();
        },

        toggleTodoCard(id) {
            const card = this.getActiveCards().find(c => c.id === id);
            if (!card) return;
            if (card.status === 2) {
                card.status = 0;
            } else {
                card.status = 2;
                const today = app.worktime.localDateString();
                if (!card.actualStart) card.actualStart = today;
                if (!card.actualEnd) card.actualEnd = today;
                if (card.progress === undefined || card.progress === null || card.progress === '') card.progress = 100;
            }
            app.saveToLocal(); this.renderTodo(); this.refreshActiveNoteUI();
        },

        clearCompletedCards() {
            app.state.workspaces[app.state.activeTabId] = this.getActiveCards().filter(c => c.status !== 2);
            if(app.state.sandbox.activeTaskId && !this.getActiveCards().find(c => c.id === app.state.sandbox.activeTaskId)) {
                this.setActiveTask(null);
            }
            app.saveToLocal(); this.renderTodo();
        },
        
        setActiveTask(id) {
            const oldId = app.state.sandbox.activeTaskId;
            if (oldId !== id && app.state.sandbox.timerStatus !== 'IDLE') {
                this.commitTimerSession('心流計時（切換任務自動結算）');
                app.state.sandbox.timerTaskId = id || null;
                app.state.sandbox.timerSessionSeconds = 0;
                app.state.sandbox.timerSessionStartedAt = app.state.sandbox.timerStatus === 'RUNNING' ? new Date().toISOString() : null;
            }
            app.state.sandbox.activeTaskId = id;
            if (app.state.sandbox.timerStatus === 'IDLE') app.state.sandbox.timerTaskId = id || null;
            this.refreshActiveNoteUI(); this.renderTodo(); this.updateDisplay();
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

            if (app.state.sandbox.activeTaskId) {
                const card = this.getActiveCards().find(c => c.id === app.state.sandbox.activeTaskId);
                if (card) {
                    iconEl.style.display = 'inline'; titleEl.value = card.title; titleEl.style.color = 'var(--primary)';
                    titleEl.readOnly = false; noteArea.value = card.content || "";
                    app.entries.renderSandbox(card);
                    return;
                } else { app.state.sandbox.activeTaskId = null; }
            }
            iconEl.style.display = 'none'; titleEl.value = "📝 全域沙盒草稿 (未綁定單一任務)"; titleEl.style.color = '#334155';
            titleEl.readOnly = true; noteArea.value = app.state.globalNotebook.free || "";
            app.entries.renderSandbox(null);
        },

        renameActiveTask() {
            if (!app.state.sandbox.activeTaskId) return;
            const newName = document.getElementById('sb-activeTaskTitle').value;
            const card = this.getActiveCards().find(c => c.id === app.state.sandbox.activeTaskId);
            if (card) { card.title = newName; app.saveToLocal(); this.renderTodo(); }
        },

        saveActiveNote() {
            const noteArea = document.getElementById('sb-activeNoteArea');
            if (app.state.sandbox.activeTaskId) {
                const card = this.getActiveCards().find(c => c.id === app.state.sandbox.activeTaskId);
                if (card) card.content = noteArea.value;
            } else { app.state.globalNotebook.free = noteArea.value; }
            app.saveToLocal();
        },

        wrapMarkdown(prefix, suffix) {
            const noteArea = document.getElementById('sb-activeNoteArea');
            const start = noteArea.selectionStart; const end = noteArea.selectionEnd;
            const selectedText = noteArea.value.substring(start, end);
            noteArea.value = noteArea.value.substring(0, start) + prefix + selectedText + suffix + noteArea.value.substring(end);
            noteArea.focus(); noteArea.selectionStart = noteArea.selectionEnd = selectedText.length === 0 ? start + prefix.length : start + prefix.length + selectedText.length + suffix.length;
            this.saveActiveNote(); this.renderTodo(); 
        },

        insertPrefix(prefix) {
            const noteArea = document.getElementById('sb-activeNoteArea'); const start = noteArea.selectionStart;
            noteArea.value = noteArea.value.substring(0, start) + prefix + noteArea.value.substring(start);
            noteArea.focus(); noteArea.selectionStart = noteArea.selectionEnd = start + prefix.length;
            this.saveActiveNote(); this.renderTodo();
        },

        insertTemplate(type) {
            let tpl = "";
            if(type==='bug') tpl="\n### 🐛 異常現象\n\n### 🔬 測試假設\n\n### 🛠️ 下一步\n";
            else if(type==='dissect') tpl="\n### 🎯 現況與目標\n\n### 🚧 卡關點\n\n### 💡 解法構思\n- [ ] \n- [ ] \n";
            else if(type==='review') tpl="\n### ✅ 已完成\n\n### ❌ 待優化\n\n### 📌 備註\n";
            this.insertPrefix(tpl);
        },

        addQuickLog() {
            const inputEl = document.getElementById('sb-quickLogInput'); const text = inputEl.value.trim(); if (!text) return;
            const noteArea = document.getElementById('sb-activeNoteArea');
            const now = new Date(); const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
            noteArea.value += `\n**[${timeStr}]** ${text}`;
            inputEl.value = ''; noteArea.scrollTop = noteArea.scrollHeight; this.saveActiveNote();
        },

        mergeSelectedCards() {
            const checkboxes = document.querySelectorAll('.todo-cb-merge:checked');
            if(checkboxes.length < 2) return alert("💡 請勾選至少兩個大卡片進行合併！");
            let mergedTitle = prompt("請輸入合併後的新母任務名稱：", "合併任務集"); if(!mergedTitle) return; 

            let mergedContent = ""; let mergedEntries = []; let mergedWorkLogs = []; let idsToDelete = []; let highestPriority = 'blue';

            checkboxes.forEach((cb, index) => {
                const id = cb.value; const card = this.getActiveCards().find(c => c.id === id);
                if(card) {
                    idsToDelete.push(id);
                    if(card.color === 'red') highestPriority = 'red'; else if(card.color === 'yellow' && highestPriority !== 'red') highestPriority = 'yellow';
                    let c = card.content ? card.content.trim() : "";
                    if (Array.isArray(card.entries)) mergedEntries.push(...card.entries);
                    if (Array.isArray(card.workLogs)) mergedWorkLogs.push(...card.workLogs);
                    mergedContent += `### 🧩 [合併來源] ${card.title}\n${c}\n`;
                    if(index < checkboxes.length - 1) mergedContent += `\n---\n\n`;
                }
            });

            const newCard = {
                id: 'card_' + Date.now(), title: mergedTitle, content: mergedContent.trim(), entries: mergedEntries, workLogs: mergedWorkLogs,
                project: '整理', dateMode: 'single', dateSingle: new Date().toISOString().split('T')[0],
                color: highestPriority, status: 0, isMemo: false
            };
            app.state.workspaces[app.state.activeTabId] = this.getActiveCards().filter(c => !idsToDelete.includes(c.id));
            app.state.workspaces[app.state.activeTabId].unshift(newCard); 
            app.saveToLocal(); this.renderTodo(); this.setActiveTask(newCard.id);
            alert("✅ 任務已成功合併！筆記與子任務已自動串接。");
        },

        renderTodo() {
            const container = document.getElementById('sb-todoListContainer');
            if(!container) return;
            const cards = this.getActiveCards();
            
            const sorted = [...cards].sort((a,b) => {
                if((a.status===2) !== (b.status===2)) return (a.status===2) ? 1 : -1;
                const wA = a.color === 'red' ? 1 : (a.color === 'yellow' ? 2 : 3);
                const wB = b.color === 'red' ? 1 : (b.color === 'yellow' ? 2 : 3);
                return wA - wB;
            });

            if (sorted.length === 0) {
                container.innerHTML = "<div style='text-align:center; color:#aaa; padding:20px; font-size: 0.9rem;'>分頁內無卡片。<br>直接輸入任務，系統會幫你建檔！</div>";
                return;
            }

            let html = '';
            sorted.forEach(c => {
                const isActive = app.state.sandbox.activeTaskId === c.id;
                const completed = c.status === 2;
                const prioLabel = c.color === 'red' ? 'P1' : (c.color === 'yellow' ? 'P2' : 'P3');
                const prioColor = c.color === 'red' ? '#dc3545' : (c.color === 'yellow' ? '#ffc107' : '#007bff');
                const subtasks = this.parseSubtasks(c.content);

                html += `
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
                                <span class="sb-badge" style="background:#6c757d; font-size:0.7em;">${c.project||'未分類'}</span>
                                ${c.category ? `<span class="sb-badge" style="background:#64748b; font-size:0.7em;">${app.entries.escapeHtml(c.category)}</span>` : ''}
                                ${app.worktime.totalSeconds(c) > 0 ? `<span class="sb-badge" style="background:#4f46e5; font-size:0.7em;">⏱ ${app.worktime.formatDuration(app.worktime.totalSeconds(c))}</span>` : ''}
                            </div>
                            <div style="font-size: 0.95rem; margin-top: 4px; font-weight: bold; color: ${isActive ? '#0056b3' : '#333'}; text-decoration: ${completed ? 'line-through' : 'none'}; opacity: ${completed ? 0.6 : 1};">${c.title || '未命名'}</div>
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 5px; margin-left: 5px;">
                            <button class="${isActive ? 'sb-btn-info' : 'sb-btn-outline'} sb-btn" style="padding:4px 8px; font-size:0.8rem;" onclick="app.sandbox.setActiveTask('${c.id}')">${isActive ? '🎯' : '📝'}</button>
                        </div>
                    </div>`;
                    
                if (subtasks.length > 0) {
                    html += `<div class="sb-subtasks-container">`;
                    subtasks.forEach(st => {
                        html += `
                        <div class="sb-subtask-item ${st.completed ? 'completed' : ''}">
                            <input type="checkbox" ${st.completed ? 'checked' : ''} onchange="app.sandbox.toggleSubtask('${c.id}', ${st.lineIndex});">
                            <span>${st.text}</span>
                        </div>`;
                    });
                    html += `</div>`;
                }
                
                html += `</div>`;
            });
            container.innerHTML = html;
        },

        promoteNodesToCards() {
            const nodes = app.state.nodes[app.state.activeTabId] || [];
            if(nodes.length === 0) return alert("此分頁目前沒有發想節點！");
            if(!confirm(`確定要將此分頁的 ${nodes.length} 個發想節點全部轉換成任務卡片嗎？\n(棋盤上的棋子會被清空)`)) return;

            nodes.forEach(node => {
                let cardColor = 'blue';
                if (node.tag === 'q1') cardColor = 'red'; else if (node.tag === 'q3') cardColor = 'yellow'; else if (node.tag === 'q2') cardColor = 'green';
                app.state.workspaces[app.state.activeTabId].push({
                    id: 'card_' + Date.now() + Math.random(), title: node.text, content: '', project: node.project || '發想',
                    category: '', plannedHours: '', progress: '', deliverable: '', acceptance: '', workLogs: [],
                    dateMode: 'single', dateSingle: new Date().toISOString().split('T')[0], color: cardColor, status: 0, isMemo: false
                });
            });
            app.state.nodes[app.state.activeTabId] = [];
            app.saveToLocal(); this.renderTodo(); alert("✅ 轉換成功！");
        },

        setTimerMode(mode) {
            if (app.state.sandbox.timerStatus !== 'IDLE') this.commitTimerSession('心流計時（切換模式自動結算）');
            clearInterval(app.state.sandbox.timerInterval);
            app.state.sandbox.timerStatus = 'IDLE'; app.state.sandbox.mode = mode;
            app.state.sandbox.timerTaskId = app.state.sandbox.activeTaskId || null;
            app.state.sandbox.timerSessionSeconds = 0; app.state.sandbox.timerSessionStartedAt = null;
            document.getElementById('sb-btn-mode-flex').className = mode === 'FLEXIBLE' ? 'sb-tab-btn active' : 'sb-tab-btn';
            document.getElementById('sb-btn-mode-pomo').className = mode === 'POMODORO' ? 'sb-tab-btn active' : 'sb-tab-btn';
            app.state.sandbox.seconds = mode === 'POMODORO' ? 25 * 60 : 0;
            this.updateDisplay(); app.saveToLocal();
        },

        startTimer() {
            if (app.state.sandbox.timerStatus === 'RUNNING') return;
            if (app.state.sandbox.timerStatus === 'IDLE') {
                app.state.sandbox.timerTaskId = app.state.sandbox.activeTaskId || null;
                app.state.sandbox.timerSessionSeconds = 0;
            }
            app.state.sandbox.timerStatus = 'RUNNING';
            app.state.sandbox.timerSessionStartedAt = new Date().toISOString();
            app.state.sandbox.timerInterval = setInterval(() => {
                app.state.sandbox.timerSessionSeconds++;
                if (app.state.sandbox.mode === 'FLEXIBLE') app.state.sandbox.seconds++;
                else {
                    app.state.sandbox.seconds--;
                    if (app.state.sandbox.seconds <= 0) { this.stopTimer(); return; }
                }
                this.updateDisplay();
            }, 1000);
            this.updateDisplay();
        },

        pauseTimer() {
            if (app.state.sandbox.timerStatus !== 'RUNNING') return;
            clearInterval(app.state.sandbox.timerInterval);
            app.state.sandbox.timerStatus = 'PAUSED';
            app.state.sandbox.timerSessionStartedAt = null;
            this.updateDisplay(); app.saveToLocal();
        },

        commitTimerSession(note = '心流計時') {
            const taskId = app.state.sandbox.timerTaskId;
            const sec = app.state.sandbox.timerSessionSeconds;
            if (taskId && sec > 0) app.worktime.addTimerLog(taskId, sec, note);
            app.state.sandbox.timerSessionSeconds = 0;
            app.state.sandbox.timerSessionStartedAt = null;
            if (taskId) {
                const card = app.worktime.getCard(taskId);
                if (card && app.state.sandbox.activeTaskId === taskId) app.entries.renderSandbox(card);
            }
        },

        stopTimer() {
            clearInterval(app.state.sandbox.timerInterval);
            this.commitTimerSession('心流計時');
            app.state.sandbox.timerStatus = 'IDLE';
            app.state.sandbox.timerTaskId = app.state.sandbox.activeTaskId || null;
            app.state.sandbox.seconds = app.state.sandbox.mode === 'POMODORO' ? 25 * 60 : 0;
            this.updateDisplay(); app.saveToLocal(); this.renderTodo();
        },

        updateDisplay() {
            let sec = app.state.sandbox.seconds;
            let h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
            let timeStr = (h>0 ? `${h.toString().padStart(2,'0')}:` : '') + `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;

            const display = document.getElementById('sb-timeDisplay');
            if (!display) return;
            display.innerText = timeStr;
            const gifBox = document.getElementById('sb-gifContainer');
            const statusText = document.getElementById('sb-statusText');
            const targetBox = document.getElementById('sb-timerTarget');

            const targetCard = app.state.sandbox.timerTaskId ? app.worktime.getCard(app.state.sandbox.timerTaskId) : null;
            const activeCard = app.state.sandbox.activeTaskId ? app.worktime.getCard(app.state.sandbox.activeTaskId) : null;
            if (targetBox) {
                if (targetCard) {
                    targetBox.innerHTML = `記錄到：<strong>${app.entries.escapeHtml(targetCard.title || '未命名')}</strong><br>本段已累積 ${app.worktime.formatDuration(app.state.sandbox.timerSessionSeconds)}，停止時自動寫入卡片。`;
                } else if (activeCard) {
                    targetBox.innerHTML = `準備記錄到：<strong>${app.entries.escapeHtml(activeCard.title || '未命名')}</strong><br>按「啟動」後開始累積工時。`;
                } else {
                    targetBox.innerText = '目前未綁定卡片。計時仍可使用，但不會寫入工時；先從任務矩陣選一張卡即可。';
                }
            }

            if (app.state.sandbox.timerStatus === 'RUNNING') {
                display.style.color = '#28a745';
                gifBox.innerHTML = `<img src="${this.GIF_URL}">`; statusText.innerText = '工作中';
            } else if (app.state.sandbox.timerStatus === 'PAUSED') {
                display.style.color = '#ffc107';
                gifBox.innerHTML = `<span style="color:#aaa">暫停</span>`; statusText.innerText = '暫停中';
            } else {
                display.style.color = '#343a40';
                gifBox.innerHTML = `<span style="color:#ccc">停止</span>`; statusText.innerText = '閒置';
            }
        },
        updateCountdown() {
            const task = document.getElementById('sb-deadlineTask').value, dateStr = document.getElementById('sb-deadlineDate').value, box = document.getElementById('sb-countdownDisplay');
            app.state.sandbox.deadlineTask = task; app.state.sandbox.deadlineDate = dateStr; app.saveToLocal(); 
            if (!dateStr) { box.style.display = 'none'; return; }
            const target = new Date(dateStr), today = new Date(); today.setHours(0,0,0,0); target.setHours(0,0,0,0);
            const diffDays = Math.ceil((target - today) / (1000 * 60 * 60 * 24));
            box.style.display = 'block';
            if (diffDays > 0) { box.style.background = '#dc3545'; box.innerHTML = `🔥 ${task} 倒數：${diffDays} 天`; }
            else if (diffDays === 0) { box.style.background = '#ffc107'; box.style.color = '#333'; box.innerHTML = `🔥 ${task} 今天截止！`; }
            else { box.style.background = '#6c757d'; box.innerHTML = `🚨 ${task} 已過期 ${Math.abs(diffDays)} 天`; }
        },
        downloadMarkdown() {
            const cards = this.getActiveCards();
            const completed = cards.filter(c => c.status === 2).length;
            
            let md = `# 🌟 心流當日總結\n*結算時間: ${new Date().toLocaleString('zh-TW')}*\n\n`;
            md += `📊 **戰報統計**：母專案完成 **${completed}** 項 / 總共 **${cards.length}** 項\n\n---\n\n`;
            if (app.state.globalNotebook.free.trim()) md += `## 📝 全域筆記\n\n${app.state.globalNotebook.free.trim()}\n\n---\n\n`;

            const formatCard = (c) => {
                let cb = c.status === 2 ? '- [x]' : '- [ ]';
                let str = `${cb} **${c.title}**\n`;
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
            a.download = `心流備份_${new Date().toISOString().split('T')[0]}.md`;
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
        
        if(viewName === 'sandbox') { 
            this.sandbox.refreshActiveNoteUI(); 
            this.sandbox.renderTodo(); 
        } else { 
            this.renderAll(); 
        }
    },

    renderAll() {
        this.renderTabs(); if (this.state.showProjectBar) this.renderProjectBar();
        
        if (this.state.view === 'timeline') this.renderTimeline(); 
        else if (this.state.view === 'kanban') this.renderKanban(); 
        else if (this.state.view === 'matrix') this.renderMatrix(); 
        else if (this.state.view === 'chronicle') this.renderChronicle(); 
        else if (this.state.view === 'gantt') this.renderGantt(); 
        else if (this.state.view === 'calendar') this.renderCalendar();
    },

    toggleProjectBar() { this.state.showProjectBar = !this.state.showProjectBar; document.getElementById('project-bar').style.display = this.state.showProjectBar ? 'flex' : 'none'; if(this.state.showProjectBar) document.body.classList.add('has-project-bar'); else document.body.classList.remove('has-project-bar'); this.renderProjectBar(); },
    openNotebook() { document.getElementById('nb-template').value = this.state.globalNotebook.template; this.renderNotebookArea(); document.getElementById('modal-notebook').style.display = 'flex'; },
    closeNotebook() { document.getElementById('modal-notebook').style.display = 'none'; },
    toggleTsumego() { this.state.tsumego.isOpen = !this.state.tsumego.isOpen; const panel = document.getElementById('tsumego-panel'); if(this.state.tsumego.isOpen) { panel.style.display = 'block'; if(window.innerWidth > 768 && panel.style.transform !== 'none' && !panel.style.left) { panel.style.top = '10vh'; panel.style.left = '10vw'; } } else { panel.style.display = 'none'; } },

    renderTabs() {
        const isMobile = window.innerWidth <= 768;
        const html = this.state.tabs.map(t => {
            const isActive = t.id === this.state.activeTabId;
            const gearBtn = (isActive && t.id !== 'main' && !isMobile) ? `<div style="margin-top:10px; font-size:1.1rem; cursor:pointer;" onclick="event.stopPropagation(); app.actions.manageTab(event, '${t.id}')">⚙️</div>` : '';
            return `<div class="tab-item ${isActive ? 'active' : ''}" onclick="app.actions.switchTab('${t.id}')" oncontextmenu="app.actions.manageTab(event, '${t.id}')"><div class="tab-name">${t.name}</div>${gearBtn}</div>`
        }).join('') + `<div class="tab-add" onclick="app.actions.addTab()">＋</div>`;
        document.getElementById('tab-bar').innerHTML = html;
    },

    renderProjectBar() {
        const cards = this.state.workspaces[this.state.activeTabId] || []; const nodes = this.state.nodes[this.state.activeTabId] || [];
        const projects = new Set([...cards.map(c => c.project), ...nodes.map(n => n.project)].filter(p => p && p.trim() !== ''));
        let html = `<div class="proj-badge" onclick="app.setFilter('project', null)">清除過濾</div>`;
        projects.forEach(p => { const active = this.state.filters.activeProject === p ? 'active' : ''; html += `<div class="proj-badge ${active}" onclick="app.setFilter('project', '${p}')">${p}</div>`; });
        document.getElementById('project-bar').innerHTML = html;
    },

    renderTimeline() {
        let cards = this.state.workspaces[this.state.activeTabId] || [];
        if (this.state.filters.activeProject) cards = cards.filter(c => c.project === this.state.filters.activeProject);
        
        cards = cards.sort((a, b) => { 
            const dA = a.dateMode === 'range' ? a.dateStart : a.dateSingle; 
            const dB = b.dateMode === 'range' ? b.dateStart : b.dateSingle; 
            if(!dA) return 1; if(!dB) return -1; return new Date(dA) - new Date(dB); 
        });

        const groupedCards = {};
        cards.forEach(card => {
            const projName = card.project || '日常雜項 (未分類)';
            if (!groupedCards[projName]) groupedCards[projName] = [];
            groupedCards[projName].push(card);
        });

        const tabOptionsHtml = this.state.tabs.map(t => `<option value="${t.id}">${t.name}</option>`).join('');

        let html = '';
        for (const [project, projCards] of Object.entries(groupedCards)) {
            html += `
            <div class="timeline-group" style="margin-top: 15px; margin-bottom: 10px;">
                <div onclick="const content = this.nextElementSibling; content.style.display = content.style.display === 'none' ? 'block' : 'none'; this.querySelector('.toggle-icon').innerText = content.style.display === 'none' ? '▶' : '▼';" 
                     style="margin-left: 45px; position: relative; z-index: 5; cursor: pointer; background: #f1f5f9; padding: 8px 12px; border-radius: 6px; font-weight: bold; color: #334155; display: flex; justify-content: space-between; border-left: 4px solid var(--primary);">
                    <span>${project} <span style="font-size: 0.8rem; color: #64748b; margin-left: 5px;">(${projCards.length} 筆任務)</span></span>
                    <span class="toggle-icon" style="font-size: 0.8rem; color: #94a3b8;">▼</span>
                </div>
                <div class="timeline-group-content" style="padding-left: 10px; margin-top: 10px;">
            `;

            html += projCards.map(card => {
                const dateHtml = card.isMemo
                    ? `<span class="free-card-note">自由卡｜不進甘特與工項 Excel</span>`
                    : (card.dateMode === 'single'
                        ? `<span style="font-size:0.8rem;color:#64748b;">預計</span><input type="date" class="input-date" value="${card.dateSingle || ''}" onchange="app.actions.updateCard('${card.id}', 'dateSingle', this.value)">`
                        : `<span style="font-size:0.8rem;color:#64748b;">預計起</span><input type="date" class="input-date" value="${card.dateStart || ''}" onchange="app.actions.updateCard('${card.id}', 'dateStart', this.value)"><span style="font-size:0.8rem;color:#64748b;">迄</span><input type="date" class="input-date" value="${card.dateEnd || ''}" onchange="app.actions.updateCard('${card.id}', 'dateEnd', this.value)">`);
                return `
                <div class="card-wrapper"><div class="card-dot"></div>
                    <div class="card ${card.isMemo ? 'memo-mode' : ''}" data-color="${card.color}" data-id="${card.id}">
                        <div class="card-header">
                            <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                                <div class="status-dot status-${card.status}" onclick="app.actions.cycleStatus('${card.id}')"></div>
                                <button class="icon-btn" onclick="app.actions.toggleMemo('${card.id}')">${card.isMemo ? '♾️' : '📅'}</button>
                                ${dateHtml}
                            </div>
                            <div style="display:flex; gap:5px;">
                                <button class="icon-btn chronicle-pin-btn ${card.chroniclePinned ? 'active' : ''}" onclick="app.actions.toggleChronicle('${card.id}')" title="${card.chroniclePinned ? '移出大事記' : '加入大事記'}">${card.chroniclePinned ? '⭐' : '☆'}</button>
                                <button class="icon-btn" onclick="app.sandbox.focusTaskForTimer('${card.id}')" title="進入心流並將計時綁定此卡">⏱️</button>
                                <button class="icon-btn" onclick="app.actions.toggleDateMode('${card.id}')">↔️</button>
                                <button class="icon-btn" onclick="app.actions.cycleColor('${card.id}')">🎨</button>
                            </div>
                        </div>
                        <div class="card-body">
                            <input type="text" class="input-title" value="${card.title}" placeholder="🏷️ 標題..." onchange="app.actions.updateCard('${card.id}', 'title', this.value)">
                            <textarea class="input-content" placeholder="📝 寫下卡片細節..." oninput="this.style.height='auto'; this.style.height=this.scrollHeight+'px';" onchange="app.actions.updateCard('${card.id}', 'content', this.value)">${card.content}</textarea>
                            ${this.worktime.renderPlanningPanel(card, 'timeline')}
                            ${this.worktime.renderPanel(card, 'timeline')}
                            ${this.entries.renderCardPanel(card, 'timeline')}
                        </div>
                        <div class="card-footer" style="display: flex; gap: 8px; align-items: center; justify-content: flex-end;">
                            <input type="text" class="input-project" value="${card.project}" placeholder="#專案名稱" onchange="app.actions.updateCard('${card.id}', 'project', this.value)">
                            <select class="icon-btn" style="width: auto; padding: 0 5px; font-size: 0.85rem;" onchange="if(this.value) { app.actions.moveCard('${card.id}', this.value); this.value=''; }">
                                <option value="" disabled selected>🚀 轉移至...</option>${tabOptionsHtml}
                            </select>
                            <button class="icon-btn" onclick="app.actions.deleteCard('${card.id}')" style="color:#ef4444; border-color:#fca5a5; width:34px; height:34px;" title="刪除此卡片">🗑️</button>
                        </div>
                    </div>
                </div>`;
            }).join('');
            
            html += `</div></div>`; 
        }

        if (cards.length === 0) {
            html = `<div style="text-align:center; padding: 40px; color: #94a3b8;">此區域目前沒有卡片，點擊右下角 ＋ 新增。</div>`;
        }

        document.getElementById('timeline-render-target').innerHTML = html;
        setTimeout(() => { document.querySelectorAll('.input-content').forEach(el => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }); }, 10);
    },

    renderKanban() {
        let cards = this.state.workspaces[this.state.activeTabId] || [];
        if (this.state.filters.activeProject) {
            cards = cards.filter(c => c.project === this.state.filters.activeProject);
        }

        const columns = [
            { id: 0, title: '📌 待辦 (To Do)', color: '#94a3b8' },
            { id: 1, title: '🚀 進行中 (Doing)', color: '#3b82f6' },
            { id: 2, title: '✅ 已完成 (Done)', color: '#10b981' },
            { id: 3, title: '⏸️ 擱置 (On Hold)', color: '#f59e0b' }
        ];

        let html = '<div style="display: flex; gap: 20px; overflow-x: auto; min-height: 65vh; padding-bottom: 20px; align-items: flex-start;">';

        columns.forEach(col => {
            const colCards = cards.filter(c => c.status === col.id);
            
            html += `
            <div style="flex: 0 0 320px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; flex-direction: column; max-height: 80vh;">
                <div style="padding: 12px; border-bottom: 3px solid ${col.color}; font-weight: bold; color: #334155; display: flex; justify-content: space-between; position: sticky; top: 0; background: #f8fafc; z-index: 10;">
                    <span>${col.title}</span>
                    <span style="background: #e2e8f0; padding: 2px 8px; border-radius: 12px; font-size: 0.8rem;">${colCards.length}</span>
                </div>
                <div style="padding: 10px; overflow-y: auto; flex-grow: 1; display: flex; flex-direction: column; gap: 10px;">
            `;

            if (colCards.length === 0) {
                html += `<div style="text-align: center; color: #cbd5e1; font-size: 0.9rem; padding: 20px 0;">無卡片</div>`;
            } else {
                const tabOptionsHtml = this.state.tabs.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
                colCards.forEach(card => {
                    html += `
                    <div class="card ${card.isMemo ? 'memo-mode' : ''}" data-color="${card.color}" data-id="${card.id}" style="margin: 0; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                        <div class="card-header" style="padding-bottom: 5px;">
                            <div style="display:flex; align-items:center; gap:8px;">
                                <div class="status-dot status-${card.status}" onclick="app.actions.cycleStatus('${card.id}')" title="點擊推進狀態"></div>
                                <button class="icon-btn" onclick="app.actions.toggleMemo('${card.id}')">${card.isMemo ? '♾️' : '📅'}</button>
                            </div>
                            <div style="display:flex;gap:5px;">
                                <button class="icon-btn chronicle-pin-btn ${card.chroniclePinned ? 'active' : ''}" onclick="app.actions.toggleChronicle('${card.id}')" title="${card.chroniclePinned ? '移出大事記' : '加入大事記'}">${card.chroniclePinned ? '⭐' : '☆'}</button>
                                <button class="icon-btn" onclick="app.sandbox.focusTaskForTimer('${card.id}')" title="進入心流並將計時綁定此卡">⏱️</button>
                                <button class="icon-btn" onclick="app.actions.cycleColor('${card.id}')">🎨</button>
                            </div>
                        </div>
                        <div class="card-body" style="padding: 5px 10px;">
                            <input type="text" class="input-title" value="${card.title}" placeholder="🏷️ 標題..." onchange="app.actions.updateCard('${card.id}', 'title', this.value)">
                            <textarea class="input-content" placeholder="📝 細節..." oninput="this.style.height='auto'; this.style.height=this.scrollHeight+'px';" onchange="app.actions.updateCard('${card.id}', 'content', this.value)" style="min-height: 40px;">${card.content}</textarea>
                            ${this.worktime.renderPlanningPanel(card, 'kanban')}
                            ${this.worktime.renderPanel(card, 'kanban')}
                            ${this.entries.renderCardPanel(card, 'kanban')}
                        </div>
                        <div class="card-footer" style="padding: 5px 10px; display: flex; gap: 5px; justify-content: space-between; align-items: center;">
                            <input type="text" class="input-project" value="${card.project}" placeholder="#專案" onchange="app.actions.updateCard('${card.id}', 'project', this.value)" style="max-width: 80px;">
                            <div style="display:flex; gap:5px;">
                                <select class="icon-btn" style="width: auto; padding: 0 2px; font-size: 0.8rem;" onchange="if(this.value) { app.actions.moveCard('${card.id}', this.value); this.value=''; }">
                                    <option value="" disabled selected>🚀</option>${tabOptionsHtml}
                                </select>
                                <button class="icon-btn" onclick="app.actions.deleteCard('${card.id}')" style="color:#ef4444; border-color:transparent; width:28px; height:28px;" title="刪除">🗑️</button>
                            </div>
                        </div>
                    </div>`;
                });
            }
            html += `</div></div>`;
        });

        html += '</div>';
        const renderTarget = document.getElementById('kanban-render-target');
        if (renderTarget) {
            renderTarget.innerHTML = html;
            setTimeout(() => { document.querySelectorAll('#kanban-render-target .input-content').forEach(el => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }); }, 10);
        }
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
                    <div class="matrix-node-text">${n.text}</div>
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
                            <textarea class="chronicle-summary-input" placeholder="例如：完成批次插入測試，主要流程已可運作。" onchange="app.actions.updateChronicleMeta('${c.id}','chronicleSummary',this.value,'${c.tabId}')">${esc(summary)}</textarea>
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

        const projects = [...new Set(sourceEntries.map(({card}) => card.project?.trim() ? card.project.trim() : NO_PROJECT))]
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
            const projectKey = card.project?.trim() ? card.project.trim() : NO_PROJECT;
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
        const summary = `<div class="gantt-summary-strip">
            <span><strong>${entries.length}</strong> 筆工項</span>
            <span>預估 <strong>${totalPlanned ? this.worktime.formatMinutes(totalPlanned) : '未估'}</strong></span>
            <span>實際 <strong>${this.worktime.formatMinutes(totalActual)}</strong></span>
            <span class="${totalRemaining < 0 ? 'over' : ''}">${esc(remainingSummary)}</span>
            <span>尺度 <strong>${scaleLabel}</strong></span>
        </div>`;

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
                const periodText = period.start.getTime() === period.end.getTime()
                    ? this.worktime.dateKey(period.start)
                    : `${this.worktime.dateKey(period.start)} ～ ${this.worktime.dateKey(period.end)}`;
                const title = esc(`${card.title || '未命名'}｜${periodText}｜${intersects ? '預計排程有涵蓋' : '無預計排程'}`);
                if (!intersects) return `<td class="gantt-day-cell ${containsToday ? 'today-col' : ''}" title="${title}"></td>`;
                const isStart = !!(start && start >= period.start && start <= period.end) || (start && start < minDate && period.start.getTime() === minDate.getTime());
                const isEnd = !!(end && end >= period.start && end <= period.end) || (end && end > displayedMaxDate && period.end.getTime() === displayedMaxDate.getTime());
                return `<td class="gantt-day-cell gantt-bar-cell ${isStart ? 'gantt-bar-start' : ''} ${isEnd ? 'gantt-bar-end' : ''} ${containsToday ? 'today-col' : ''}" style="background:${cfg.light};" title="${title}"></td>`;
            }).join('');

            const actualPeriodRow = periods.map(period => {
                const containsToday = today >= period.start && today <= period.end;
                let periodMins = 0;
                let logCount = 0;
                let outsideCount = 0;
                logs.forEach(log => {
                    const d = this.worktime.parseLocalDate(log.workDate);
                    const mins = this.worktime.logMinutes(log);
                    if (!d || mins <= 0 || d < period.start || d > period.end) return;
                    periodMins += mins;
                    logCount++;
                    if (start && end && (d < start || d > end)) outsideCount++;
                });
                const periodText = period.start.getTime() === period.end.getTime()
                    ? this.worktime.dateKey(period.start)
                    : `${this.worktime.dateKey(period.start)} ～ ${this.worktime.dateKey(period.end)}`;
                const titleParts = [`${card.title || '未命名'}｜${periodText}`];
                if (periodMins > 0) titleParts.push(`實際 ${this.worktime.formatMinutes(periodMins)}（${logCount} 筆）`);
                else titleParts.push('此期間無工時紀錄');
                if (outsideCount > 0) titleParts.push(`⚠ ${outsideCount} 筆排程外工時`);
                const title = esc(titleParts.join('｜'));
                if (periodMins > 0) {
                    return `<td class="gantt-day-cell gantt-work-cell ${outsideCount > 0 ? 'gantt-work-outside' : ''} ${containsToday ? 'today-col' : ''}" style="background:${cfg.hex};" title="${title}"><span>${esc(this.worktime.compactMinutes(periodMins))}</span></td>`;
                }
                return `<td class="gantt-day-cell ${containsToday ? 'today-col' : ''}" title="${title}"></td>`;
            }).join('');

            body += `
                <tr class="gantt-plan-row ${mode === 'time' ? 'gantt-time-focus' : ''}" style="cursor:pointer;" onclick="app.actions.jumpToCard('${card.id}','${tabId}')" title="點擊跳回卡片">
                    <td rowspan="2" class="gantt-left gantt-title-col gantt-rowspan-cell">
                        <div class="gantt-task-title"><span class="color-chip" style="background:${cfg.hex}"></span><span>${esc(card.title || '未命名')}</span></div>
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
            : `<div class="gantt-mode-note">📅 排程模式：上層顯示預計排程，下層顯示${granularity}實際投入。日／週／月只是檢視尺度，不會改寫卡片資料。</div>`;
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
                        <div style="color:#64748b; font-size:0.75rem; margin-bottom:2px; font-weight:bold;">${c.tabName}</div>
                        <div style="color:#1e293b;">${c.title || '未命名'}</div>
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
        if (d.template === 'free') { html = `<textarea class="nb-textarea" onchange="app.actions.updateNotebook('free', this.value)" placeholder="在這裡傾倒您的思緒...">${d.free || ''}</textarea>`; } 
        else if (d.template === 'matrix') { const m = d.matrix || {}; html = `<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap:15px;"><div style="background:#fef2f2; padding:15px; border-radius:8px; border:1px solid #fca5a5;"><span style="color:#ef4444; font-weight:bold; font-size:1.1rem; display:block; margin-bottom:10px;">🔥 重要・緊急</span><textarea class="nb-textarea" style="height:150px; background:white;" onchange="app.actions.updateNotebook('matrix.q1', this.value)">${m.q1 || ''}</textarea></div><div style="background:#eff6ff; padding:15px; border-radius:8px; border:1px solid #bfdbfe;"><span style="color:#3b82f6; font-weight:bold; font-size:1.1rem; display:block; margin-bottom:10px;">📅 重要・不急</span><textarea class="nb-textarea" style="height:150px; background:white;" onchange="app.actions.updateNotebook('matrix.q2', this.value)">${m.q2 || ''}</textarea></div><div style="background:#fffbeb; padding:15px; border-radius:8px; border:1px solid #fde68a;"><span style="color:#f59e0b; font-weight:bold; font-size:1.1rem; display:block; margin-bottom:10px;">⚡ 緊急・不重</span><textarea class="nb-textarea" style="height:150px; background:white;" onchange="app.actions.updateNotebook('matrix.q3', this.value)">${m.q3 || ''}</textarea></div><div style="background:#f0fdf4; padding:15px; border-radius:8px; border:1px solid #bbf7d0;"><span style="color:#10b981; font-weight:bold; font-size:1.1rem; display:block; margin-bottom:10px;">☕ 不重・不急</span><textarea class="nb-textarea" style="height:150px; background:white;" onchange="app.actions.updateNotebook('matrix.q4', this.value)">${m.q4 || ''}</textarea></div></div>`; }
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
        if (this.state.view === 'chronicle') this.renderChronicle();
    },

    // ==========================================
    // 基礎 Actions (增刪改查)
    // ==========================================
    actions: {
        addCard(mode = 'free') {
            const today = app.worktime.localDateString();
            const scheduled = mode === 'scheduled';
            const newCard = {
                id: 'card_' + Date.now(), title: '', content: '', project: app.state.filters.activeProject || '',
                category: '', progress: '', deliverable: '', acceptance: '', workLogs: [],
                dateMode: scheduled ? 'range' : 'single', dateSingle: scheduled ? '' : '',
                dateStart: scheduled ? today : '', dateEnd: scheduled ? today : '',
                color: 'blue', status: 0, isMemo: !scheduled
            };
            app.state.workspaces[app.state.activeTabId].push(newCard);
            app.saveToLocal(); app.renderAll();
        },
        updateCard(id, field, value) { const card = app.state.workspaces[app.state.activeTabId].find(c => c.id === id); if (card) { card[field] = value; app.saveToLocal(); app.renderAll(); } },

        getCardInTab(id, targetTabId = null) {
            if (targetTabId && app.state.workspaces[targetTabId]) {
                const direct = app.state.workspaces[targetTabId].find(c => c.id === id);
                if (direct) return direct;
            }
            for (const tabId in app.state.workspaces) {
                const card = (app.state.workspaces[tabId] || []).find(c => c.id === id);
                if (card) return card;
            }
            return null;
        },

        toggleChronicle(id, targetTabId = null) {
            const card = this.getCardInTab(id, targetTabId);
            if (!card) return;
            card.chroniclePinned = !card.chroniclePinned;
            if (card.chroniclePinned && !card.chronicleDate) card.chronicleDate = app.worktime.localDateString();
            app.saveToLocal();
            app.renderAll();
        },

        updateChronicleMeta(id, field, value, targetTabId = null) {
            if (!['chronicleDate', 'chronicleSummary'].includes(field)) return;
            const card = this.getCardInTab(id, targetTabId);
            if (!card) return;
            card[field] = value;
            app.saveToLocal();
            if (app.state.view === 'chronicle') app.renderChronicle();
        },
        
        // 👻 升級版：支援跨分頁、清洗沙盒的刪除機制
        deleteCard(id, targetTabId = null) {
            if (!confirm('⚠️ 確定移除此卡片嗎？刪除後無法復原。')) return;
            
            let foundTabId = targetTabId;
            if (!foundTabId) {
                for (let tab in app.state.workspaces) {
                    if (app.state.workspaces[tab].find(c => c.id === id)) {
                        foundTabId = tab;
                        break;
                    }
                }
            }
            if (!foundTabId) return;

            app.state.workspaces[foundTabId] = app.state.workspaces[foundTabId].filter(c => c.id !== id);
            
            // 🧹 核心防呆：如果刪除的剛好是沙盒正在編輯的任務，立刻清空焦點
            if (app.state.sandbox.activeTaskId === id) {
                app.sandbox.setActiveTask(null);
            }
            
            app.saveToLocal();
            app.renderAll(); // 重新渲染確保畫面同步
        },

        // 🚀 新增：全域日曆/甘特圖專用的跳轉機制
        jumpToCard(id, tabId) {
            app.actions.switchTab(tabId); 
            app.switchView('timeline');   
            
            setTimeout(() => {
                const targetEl = document.querySelector(`.card[data-id="${id}"]`);
                if (targetEl) {
                    targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    const origBoxShadow = targetEl.style.boxShadow;
                    targetEl.style.boxShadow = '0 0 15px 3px rgba(59, 130, 246, 0.6)';
                    setTimeout(() => targetEl.style.boxShadow = origBoxShadow, 1500);
                }
            }, 100);
        },

        moveCard(id, targetTabId) {
            const currentTabId = app.state.activeTabId; if (currentTabId === targetTabId) return;
            const cardIndex = app.state.workspaces[currentTabId].findIndex(c => c.id === id);
            if (cardIndex !== -1) {
                const [card] = app.state.workspaces[currentTabId].splice(cardIndex, 1);
                if (!app.state.workspaces[targetTabId]) app.state.workspaces[targetTabId] = [];
                app.state.workspaces[targetTabId].push(card); app.saveToLocal(); app.renderAll();
            }
        },
        cycleStatus(id) {
            const card = app.state.workspaces[app.state.activeTabId].find(c => c.id === id);
            if (!card) return;
            const next = (Number(card.status || 0) + 1) % 4;
            card.status = next;
            const today = app.worktime.localDateString();
            if (next === 1 && !card.actualStart) card.actualStart = today;
            if (next === 2) {
                if (!card.actualStart) card.actualStart = today;
                if (!card.actualEnd) card.actualEnd = today;
                if (card.progress === undefined || card.progress === null || card.progress === '') card.progress = 100;
            }
            app.saveToLocal(); app.renderAll();
        },
        cycleColor(id) { const card = app.state.workspaces[app.state.activeTabId].find(c => c.id === id); const colors = ['blue', 'green', 'red', 'yellow']; if (card) { card.color = colors[(colors.indexOf(card.color) + 1) % colors.length]; app.saveToLocal(); app.renderAll(); } },
        toggleMemo(id) {
            const card = app.state.workspaces[app.state.activeTabId].find(c => c.id === id);
            if (!card) return;
            card.isMemo = !card.isMemo;
            if (!card.isMemo && !app.worktime.plannedStart(card)) {
                const today = app.worktime.localDateString();
                card.dateMode = 'range'; card.dateStart = today; card.dateEnd = today;
            }
            app.saveToLocal(); app.renderAll();
        },
        toggleDateMode(id) { const card = app.state.workspaces[app.state.activeTabId].find(c => c.id === id); if (card) { card.dateMode = card.dateMode === 'single' ? 'range' : 'single'; app.saveToLocal(); app.renderAll(); } },
        
        addMatrixNode() {
            const inputEl = document.getElementById('matrix-quick-input'); const tagEl = document.getElementById('matrix-tag-select');
            const text = inputEl.value.trim(); if(!text) return;
            if(!app.state.nodes[app.state.activeTabId]) app.state.nodes[app.state.activeTabId] = [];
            const gridX = Math.floor(Math.random() * 7) + 6; const gridY = Math.floor(Math.random() * 7) + 6;
            app.state.nodes[app.state.activeTabId].push({ id: 'node_' + Date.now(), text: text, tag: tagEl.value, gridX: gridX, gridY: gridY, stoneColor: 'white', project: app.state.filters.activeProject || '' });
            inputEl.value = ''; app.saveToLocal(); app.renderMatrix();
        },
        updateMatrixNodePos(id, gridX, gridY) { const node = app.state.nodes[app.state.activeTabId].find(n => n.id === id); if(node) { node.gridX = gridX; node.gridY = gridY; app.saveToLocal(); app.renderMatrix(); } },
        toggleStoneColor(id) { const node = app.state.nodes[app.state.activeTabId].find(n => n.id === id); if(node) { node.stoneColor = node.stoneColor === 'black' ? 'white' : 'black'; app.saveToLocal(); app.renderMatrix(); } },
        deleteMatrixNode(id) { app.state.nodes[app.state.activeTabId] = app.state.nodes[app.state.activeTabId].filter(n => n.id !== id); app.saveToLocal(); app.renderMatrix(); },
        promoteToCard(id) {
            const nodes = app.state.nodes[app.state.activeTabId]; const idx = nodes.findIndex(n => n.id === id); if(idx === -1) return;
            const node = nodes[idx]; let cardColor = 'blue';
            if (node.tag === 'q1') cardColor = 'red'; else if (node.tag === 'q3') cardColor = 'yellow'; else if (node.tag === 'q2') cardColor = 'green';
            app.state.workspaces[app.state.activeTabId].push({ id: 'card_' + Date.now(), title: node.text, content: '', project: node.project, dateMode: 'single', dateSingle: new Date().toISOString().split('T')[0], color: cardColor, status: 0, isMemo: false });
            nodes.splice(idx, 1); app.saveToLocal(); app.renderAll(); alert(`🚀 已轉為正式排程卡片！`);
        },

        switchTab(id) { app.state.activeTabId = id; app.state.filters.activeProject = null; app.renderAll(); },
        addTab() { const name = prompt("請輸入新工作區名稱："); if (name) { const id = 'tab_' + Date.now(); app.state.tabs.push({ id, name }); app.state.workspaces[id] = []; app.state.nodes[id] = []; app.state.activeTabId = id; app.saveToLocal(); app.renderAll(); } },
        manageTab(e, id) {
            e.preventDefault(); if (id === 'main') { alert('「主工作區」無法修改或刪除！'); return; }
            const tab = app.state.tabs.find(t => t.id === id); const action = prompt(`管理分頁：「${tab.name}」\n[1] 重新命名\n[2] 刪除分頁`);
            if (action === '1') { const newName = prompt('請輸入新名稱：', tab.name); if (newName && newName.trim() !== '') { tab.name = newName.trim(); app.saveToLocal(); app.renderAll(); } } 
            else if (action === '2') { if (confirm(`⚠️ 確定刪除「${tab.name}」嗎？資料將消失！`)) { app.state.tabs = app.state.tabs.filter(t => t.id !== id); delete app.state.workspaces[id]; delete app.state.nodes[id]; app.state.activeTabId = 'main'; app.saveToLocal(); app.renderAll(); } }
        },
        updateNotebookTemplate(val) { app.state.globalNotebook.template = val; app.saveToLocal(); app.renderNotebookArea(); },
        updateNotebook(field, val) { if (field === 'free') app.state.globalNotebook.free = val; else { const key = field.split('.')[1]; app.state.globalNotebook.matrix[key] = val; } app.saveToLocal(); },

        setTsumegoColor(color) {
            if (color === 'clear') { app.state.tsumego.currentColor = 'clear'; } else { app.state.tsumego.currentColor = color; }
            document.querySelectorAll('.tsumego-tool-btn').forEach(btn => btn.classList.remove('active'));
            document.getElementById('ts-btn-' + color).classList.add('active');
        },
        placeTsumegoStone(e) {
            const gridBox = document.getElementById('tsumego-grid-lines'); const rect = gridBox.getBoundingClientRect();
            let rawX = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left; let rawY = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
            let gridX = Math.round((rawX / rect.width) * 18); let gridY = Math.round((rawY / rect.height) * 18);
            if (gridX < 0 || gridX > 18 || gridY < 0 || gridY > 18) return;
            const existingIdx = app.state.tsumego.stones.findIndex(s => s.x === gridX && s.y === gridY);
            if (app.state.tsumego.currentColor === 'clear') { if (existingIdx > -1) { app.state.tsumego.stones.splice(existingIdx, 1); app.saveToLocal(); app.renderTsumegoStones(); } } 
            else { if (existingIdx > -1) { app.state.tsumego.stones[existingIdx].color = app.state.tsumego.currentColor; } else { app.state.tsumego.stones.push({ x: gridX, y: gridY, color: app.state.tsumego.currentColor }); } app.saveToLocal(); app.renderTsumegoStones(); }
        },
        resetTsumego() { if(confirm("確定要清空盤面？")) { app.state.tsumego.stones = []; app.saveToLocal(); app.renderTsumegoStones(); } }
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
window.addEventListener('resize', () => {
    if (app.state.view === 'matrix') app.renderMatrix();
    if (app.state.tsumego.isOpen) app.renderTsumegoStones();
});
