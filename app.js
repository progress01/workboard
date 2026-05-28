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
        showProjectBar: false,
        
        // SPA 沙盒專屬狀態
        sandbox: {
            activeTaskId: null,
            mode: 'FLEXIBLE', timerStatus: 'IDLE', seconds: 0,
            pomoPhase: 'FOCUS', pomoCount: 0, timerInterval: null,
            deadlineTask: '', deadlineDate: ''
        }
    },

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
    // 🌟 終極沙盒 SPA (子任務雙向綁定) 🌟
    // ==========================================
    sandbox: {
        GIF_URL: "https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif",
        
        initUI() {
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
            if (card) { card.status = card.status === 2 ? 0 : 2; app.saveToLocal(); this.renderTodo(); }
        },

        clearCompletedCards() {
            app.state.workspaces[app.state.activeTabId] = this.getActiveCards().filter(c => c.status !== 2);
            if(app.state.sandbox.activeTaskId && !this.getActiveCards().find(c => c.id === app.state.sandbox.activeTaskId)) {
                this.setActiveTask(null);
            }
            app.saveToLocal(); this.renderTodo();
        },
        
        setActiveTask(id) { app.state.sandbox.activeTaskId = id; this.refreshActiveNoteUI(); this.renderTodo(); },

        refreshActiveNoteUI() {
            const titleEl = document.getElementById('sb-activeTaskTitle');
            const iconEl = document.getElementById('sb-activeTaskIcon');
            const noteArea = document.getElementById('sb-activeNoteArea');

            if (app.state.sandbox.activeTaskId) {
                const card = this.getActiveCards().find(c => c.id === app.state.sandbox.activeTaskId);
                if (card) {
                    iconEl.style.display = 'inline'; titleEl.value = card.title; titleEl.style.color = 'var(--primary)';
                    titleEl.readOnly = false; noteArea.value = card.content || ""; 
                    return;
                } else { app.state.sandbox.activeTaskId = null; }
            }
            iconEl.style.display = 'none'; titleEl.value = "📝 全域沙盒草稿 (未綁定單一任務)"; titleEl.style.color = '#334155';
            titleEl.readOnly = true; noteArea.value = app.state.globalNotebook.free || ""; 
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

            let mergedContent = ""; let idsToDelete = []; let highestPriority = 'blue';

            checkboxes.forEach((cb, index) => {
                const id = cb.value; const card = this.getActiveCards().find(c => c.id === id);
                if(card) {
                    idsToDelete.push(id);
                    if(card.color === 'red') highestPriority = 'red'; else if(card.color === 'yellow' && highestPriority !== 'red') highestPriority = 'yellow';
                    let c = card.content ? card.content.trim() : "";
                    mergedContent += `### 🧩 [合併來源] ${card.title}\n${c}\n`;
                    if(index < checkboxes.length - 1) mergedContent += `\n---\n\n`;
                }
            });

            const newCard = {
                id: 'card_' + Date.now(), title: mergedTitle, content: mergedContent.trim(),
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
                    dateMode: 'single', dateSingle: new Date().toISOString().split('T')[0], color: cardColor, status: 0, isMemo: false
                });
            });
            app.state.nodes[app.state.activeTabId] = [];
            app.saveToLocal(); this.renderTodo(); alert("✅ 轉換成功！");
        },

        setTimerMode(mode) {
            clearInterval(app.state.sandbox.timerInterval); 
            app.state.sandbox.timerStatus = 'IDLE'; app.state.sandbox.mode = mode;
            document.getElementById('sb-btn-mode-flex').className = mode === 'FLEXIBLE' ? 'sb-tab-btn active' : 'sb-tab-btn';
            document.getElementById('sb-btn-mode-pomo').className = mode === 'POMODORO' ? 'sb-tab-btn active' : 'sb-tab-btn';
            app.state.sandbox.seconds = mode === 'POMODORO' ? 25 * 60 : 0;
            this.updateDisplay(); app.saveToLocal();
        },
        startTimer() {
            if (app.state.sandbox.timerStatus === 'RUNNING') return;
            app.state.sandbox.timerStatus = 'RUNNING';
            app.state.sandbox.timerInterval = setInterval(() => {
                if (app.state.sandbox.mode === 'FLEXIBLE') app.state.sandbox.seconds++;
                else { app.state.sandbox.seconds--; if (app.state.sandbox.seconds <= 0) this.stopTimer(); }
                this.updateDisplay(); if(app.state.sandbox.seconds % 30 === 0) app.saveToLocal(); 
            }, 1000);
            this.updateDisplay();
        },
        pauseTimer() { 
            if (app.state.sandbox.timerStatus !== 'RUNNING') return; 
            clearInterval(app.state.sandbox.timerInterval); 
            app.state.sandbox.timerStatus = 'PAUSED'; 
            this.updateDisplay(); app.saveToLocal(); 
        },
        stopTimer() { 
            clearInterval(app.state.sandbox.timerInterval); 
            app.state.sandbox.timerStatus = 'IDLE'; 
            app.state.sandbox.seconds = app.state.sandbox.mode === 'POMODORO' ? 25 * 60 : 0;
            this.updateDisplay(); app.saveToLocal();
        },
        updateDisplay() {
            let sec = app.state.sandbox.seconds;
            let h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
            let timeStr = (h>0 ? `${h.toString().padStart(2,'0')}:` : '') + `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
            
            document.getElementById('sb-timeDisplay').innerText = timeStr;
            const gifBox = document.getElementById('sb-gifContainer');
            const statusText = document.getElementById('sb-statusText');

            if (app.state.sandbox.timerStatus === 'RUNNING') {
                document.getElementById('sb-timeDisplay').style.color = '#28a745';
                gifBox.innerHTML = `<img src="${this.GIF_URL}">`; statusText.innerText = "工作中";
            } else if (app.state.sandbox.timerStatus === 'PAUSED') {
                document.getElementById('sb-timeDisplay').style.color = '#ffc107'; 
                gifBox.innerHTML = `<span style="color:#aaa">暫停</span>`; statusText.innerText = "暫停中";
            } else {
                document.getElementById('sb-timeDisplay').style.color = '#343a40'; 
                gifBox.innerHTML = `<span style="color:#ccc">停止</span>`; statusText.innerText = "閒置";
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
                const dateHtml = card.dateMode === 'single' ? `<input type="date" class="input-date" value="${card.dateSingle}" onchange="app.actions.updateCard('${card.id}', 'dateSingle', this.value)">` : `<span style="font-size:0.8rem;color:#64748b;">起</span><input type="date" class="input-date" value="${card.dateStart}" onchange="app.actions.updateCard('${card.id}', 'dateStart', this.value)"><span style="font-size:0.8rem;color:#64748b;">迄</span><input type="date" class="input-date" value="${card.dateEnd}" onchange="app.actions.updateCard('${card.id}', 'dateEnd', this.value)">`;
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
                                <button class="icon-btn" onclick="app.actions.toggleDateMode('${card.id}')">↔️</button>
                                <button class="icon-btn" onclick="app.actions.cycleColor('${card.id}')">🎨</button>
                            </div>
                        </div>
                        <div class="card-body">
                            <input type="text" class="input-title" value="${card.title}" placeholder="🏷️ 標題..." onchange="app.actions.updateCard('${card.id}', 'title', this.value)">
                            <textarea class="input-content" placeholder="📝 寫下卡片細節..." oninput="this.style.height='auto'; this.style.height=this.scrollHeight+'px';" onchange="app.actions.updateCard('${card.id}', 'content', this.value)">${card.content}</textarea>
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
                            <button class="icon-btn" onclick="app.actions.cycleColor('${card.id}')">🎨</button>
                        </div>
                        <div class="card-body" style="padding: 5px 10px;">
                            <input type="text" class="input-title" value="${card.title}" placeholder="🏷️ 標題..." onchange="app.actions.updateCard('${card.id}', 'title', this.value)">
                            <textarea class="input-content" placeholder="📝 細節..." oninput="this.style.height='auto'; this.style.height=this.scrollHeight+'px';" onchange="app.actions.updateCard('${card.id}', 'content', this.value)" style="min-height: 40px;">${card.content}</textarea>
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
        let allCards = []; 
        for (let tabId in this.state.workspaces) { 
            const tabName = this.state.tabs.find(t => t.id === tabId)?.name || '未知'; 
            this.state.workspaces[tabId].forEach(c => allCards.push({ ...c, tabId, tabName })); 
        }
        const cards = allCards.filter(c => !c.isMemo && (c.dateSingle || c.dateStart)); 
        if (cards.length === 0) { document.getElementById('chronicle-render-target').innerHTML = '<p style="text-align:center; color:#94a3b8;">無有效日期之卡片</p>'; return; }
        
        const sorted = cards.sort((a, b) => { const d1 = new Date(a.dateMode === 'range' ? a.dateStart : a.dateSingle).getTime() || 0; const d2 = new Date(b.dateMode === 'range' ? b.dateStart : b.dateSingle).getTime() || 0; return d1 - d2; });
        const html = sorted.map(c => { 
            const dStr = c.dateMode === 'range' ? `${c.dateStart} ~ ${c.dateEnd}` : c.dateSingle; 
            const pTag = c.project ? `<span style="background:#e2e8f0; padding:2px 6px; border-radius:4px; font-size:0.8rem; margin-right:8px;">#${c.project}</span>` : ''; 
            return `<div class="chronicle-row" onclick="app.actions.jumpToCard('${c.id}', '${c.tabId}')" style="cursor:pointer;" title="點擊跳轉編輯">
                <div class="chronicle-date">${dStr}</div>
                <div class="chronicle-info">
                    <div style="display:flex; align-items:center; margin-bottom:5px;">
                        <div class="status-dot status-${c.status}" style="margin-right:8px;"></div>
                        <div class="chronicle-title">${pTag}<span style="color:#64748b; font-size:0.8rem; margin-right:5px;">[${c.tabName}]</span>${c.title || '未命名'}</div>
                    </div>
                    <div style="color:#475569; font-size:0.95rem; white-space:pre-wrap;">${c.content}</div>
                </div>
            </div>`; 
        }).join('');
        document.getElementById('chronicle-render-target').innerHTML = html;
    },

    renderGantt() {
        let allCards = []; 
        for (let tabId in this.state.workspaces) { 
            const tabName = this.state.tabs.find(t => t.id === tabId)?.name || '未知'; 
            this.state.workspaces[tabId].forEach(c => allCards.push({ ...c, tabId, tabName })); 
        }
        const cards = allCards.filter(c => !c.isMemo && c.dateMode === 'range' && c.dateStart && c.dateEnd); 
        if (cards.length === 0) { document.getElementById('gantt-render-target').innerHTML = '<p style="text-align:center; color:#94a3b8;">請將卡片切換為「區間模式 (↔️)」並設定起迄日期</p>'; return; }
        
        const minTime = Math.min(...cards.map(c => new Date(c.dateStart).getTime()));
        
        let html = '<div style="display:flex; flex-direction:column; gap:10px; min-width: 600px; padding-bottom: 20px;">';
        cards.forEach(c => { 
            const s = new Date(c.dateStart).getTime(); 
            const e = new Date(c.dateEnd).getTime(); 
            const days = Math.max(1, (e - s) / (1000 * 60 * 60 * 24)); 
            const offsetDays = Math.max(0, (s - minTime) / (1000 * 60 * 60 * 24));
            
            const widthPx = Math.max(30, days * 25);
            const marginLeftPx = offsetDays * 25;

            html += `
            <div style="background:#f1f5f9; border-radius:6px; padding:10px; border: 1px solid #e2e8f0; cursor:pointer;" onclick="app.actions.jumpToCard('${c.id}', '${c.tabId}')" title="點擊跳轉編輯">
                <div style="font-weight:bold; margin-bottom:5px; font-size:0.95rem; color:#1e293b; display:flex; justify-content:space-between;">
                    <span><span style="color:#64748b; font-size:0.8rem; margin-right:5px;">[${c.tabName}]</span>${c.project ? '#'+c.project : ''} ${c.title || '未命名'} <span style="font-size:0.8rem; color:#64748b; font-weight:normal;">(${days}天)</span></span>
                    <button class="icon-btn" onclick="event.stopPropagation(); app.actions.deleteCard('${c.id}', '${c.tabId}')" style="color:#ef4444; border:none; background:transparent; padding:0; width:20px; height:20px;">🗑️</button>
                </div>
                <div style="height:12px; background:#e2e8f0; border-radius:6px; width:100%; position: relative;">
                    <div style="height:100%; border-radius:6px; background:var(--primary); width:${widthPx}px; margin-left:${marginLeftPx}px;"></div>
                </div>
            </div>`; 
        });
        document.getElementById('gantt-render-target').innerHTML = html + '</div>';
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

    // ==========================================
    // 基礎 Actions (增刪改查)
    // ==========================================
    actions: {
        addCard() { const newCard = { id: 'card_' + Date.now(), title: '', content: '', project: app.state.filters.activeProject || '', dateMode: 'single', dateSingle: new Date().toISOString().split('T')[0], color: 'blue', status: 0, isMemo: false }; app.state.workspaces[app.state.activeTabId].push(newCard); app.saveToLocal(); app.renderAll(); },
        updateCard(id, field, value) { const card = app.state.workspaces[app.state.activeTabId].find(c => c.id === id); if (card) { card[field] = value; app.saveToLocal(); app.renderAll(); } },
        
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
        cycleStatus(id) { const card = app.state.workspaces[app.state.activeTabId].find(c => c.id === id); if (card) { card.status = (card.status + 1) % 4; app.saveToLocal(); app.renderAll(); } },
        cycleColor(id) { const card = app.state.workspaces[app.state.activeTabId].find(c => c.id === id); const colors = ['blue', 'green', 'red', 'yellow']; if (card) { card.color = colors[(colors.indexOf(card.color) + 1) % colors.length]; app.saveToLocal(); app.renderAll(); } },
        toggleMemo(id) { const card = app.state.workspaces[app.state.activeTabId].find(c => c.id === id); if (card) { card.isMemo = !card.isMemo; app.saveToLocal(); app.renderAll(); } },
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

// === 啟動應用 ===
app.init();
window.addEventListener('resize', () => {
    if (app.state.view === 'matrix') app.renderMatrix();
    if (app.state.tsumego.isOpen) app.renderTsumegoStones();
});
