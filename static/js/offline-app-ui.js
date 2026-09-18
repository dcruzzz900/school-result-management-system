/*
 * The offline app shell (templates/offline_app.html) is a normal
 * server-rendered page like every other page in this app — the point is
 * that its HTML/CSS/JS is small and static enough to be fully precached by
 * the service worker (see SHELL_ASSETS in service-worker.js), so it opens
 * with zero network at all, including for a device's very first login of
 * the day. Everything it shows comes from IndexedDB, not from the server,
 * once it's open.
 *
 * This intentionally covers three representative offline workflows
 * (attendance, score entry, student registration) plus sync status/
 * conflict resolution, rather than reimplementing every admin screen as a
 * client-rendered view — see OFFLINE_ARCHITECTURE.md for the extension
 * pattern used to bring more screens in over time.
 */
(function () {
    const root = document.getElementById("offlineRoot");
    let session = null;   // { device_id, device_secret, user, started_at }
    let schoolId = null;

    function el(html) {
        const t = document.createElement("template");
        t.innerHTML = html.trim();
        return t.content.firstElementChild;
    }

    function todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    // ---------------- boot ----------------

    async function boot() {
        session = OfflineAuth.getSession();
        if (session) {
            schoolId = session.user.school_id;
            renderHome();
        } else {
            await renderAccountPicker();
        }
        document.addEventListener("offline-sync-status", (e) => renderStatusBar(e.detail));
        window.addEventListener("online", () => renderStatusBar());
        window.addEventListener("offline", () => renderStatusBar());
        renderStatusBar();
    }

    async function renderStatusBar(detail) {
        const bar = document.getElementById("offlineStatusBar");
        if (!bar) return;
        if (!detail && schoolId) detail = await OfflineDB.getPendingCounts(schoolId).then((c) => ({ ...c, online: navigator.onLine }));
        if (!detail) detail = { online: navigator.onLine, pending: 0, conflict: 0, failed: 0 };
        bar.innerHTML = `
            <span class="badge" style="background:${detail.online ? '#2e7d4f' : '#b3261e'}; color:#fff;">${detail.online ? "Online" : "Offline"}</span>
            ${detail.pending ? `<span class="badge">${detail.pending} pending</span>` : ""}
            ${detail.conflict ? `<span class="badge" style="background:#b3261e;color:#fff;">${detail.conflict} conflicts</span>` : ""}
            ${detail.failed ? `<span class="badge" style="background:#a97f22;color:#fff;">${detail.failed} failed</span>` : ""}
        `;
    }

    // ---------------- account picker / unlock ----------------

    async function renderAccountPicker() {
        const accounts = await OfflineAuth.listAccounts();
        root.innerHTML = "";
        const card = el(`<div class="card login-wrapper"><h2>Offline Login</h2></div>`);
        if (!accounts.length) {
            card.appendChild(el(`<p>No offline accounts are set up on this device yet. While online, go to <b>Settings → Offline Access</b> to enable it.</p>`));
            root.appendChild(card);
            return;
        }
        card.appendChild(el(`<p>Choose your account:</p>`));
        for (const account of accounts) {
            const btn = el(`<button class="btn" style="display:block; width:100%; margin-bottom:0.5rem;">${account.label}</button>`);
            btn.addEventListener("click", () => renderPinPrompt(account));
            card.appendChild(btn);
        }
        root.appendChild(card);
    }

    function renderPinPrompt(account) {
        root.innerHTML = "";
        const card = el(`
            <div class="card login-wrapper">
                <h2>${account.label}</h2>
                <p>Enter your offline PIN</p>
                <input type="password" inputmode="numeric" id="pinInput" style="text-align:center; font-size:1.4rem; letter-spacing:0.3rem;" autofocus>
                <p id="pinError" style="color:#b3261e;"></p>
                <button class="btn" id="unlockBtn">Unlock</button>
                <button class="btn" id="backBtn" style="background:#888; margin-top:0.5rem;">Back</button>
            </div>
        `);
        root.appendChild(card);
        document.getElementById("backBtn").addEventListener("click", renderAccountPicker);
        document.getElementById("unlockBtn").addEventListener("click", async () => {
            const pin = document.getElementById("pinInput").value;
            try {
                const user = await OfflineAuth.unlock(account.device_id, pin);
                session = OfflineAuth.getSession();
                schoolId = user.school_id;
                SyncEngine.startAutoSync(schoolId);
                renderHome();
            } catch (e) {
                document.getElementById("pinError").textContent = e.message;
            }
        });
    }

    // ---------------- home ----------------

    function frame(title, bodyEl) {
        root.innerHTML = "";
        const wrap = el(`<div></div>`);
        const header = el(`
            <div class="card" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
                <div><b>${session.user.name}</b> — ${session.user.role.replace("_", " ")}</div>
                <div id="offlineStatusBar"></div>
                <div>
                    <button class="btn btn-small" id="syncNowBtn">Sync Now</button>
                    <button class="btn btn-small" id="lockBtn" style="background:#888;">Lock</button>
                </div>
            </div>
        `);
        header.querySelector("#syncNowBtn").addEventListener("click", async () => {
            const s = OfflineAuth.getSession();
            await SyncEngine.syncNow(schoolId, s.device_id, s.device_secret);
        });
        header.querySelector("#lockBtn").addEventListener("click", () => {
            OfflineAuth.lock();
            SyncEngine.stopAutoSync();
            renderAccountPicker();
        });
        wrap.appendChild(header);
        wrap.appendChild(el(`<h2>${title}</h2>`));
        wrap.appendChild(bodyEl);
        root.appendChild(wrap);
        renderStatusBar();
    }

    function renderHome() {
        const body = el(`<div class="stat-grid"></div>`);
        const items = [
            ["Attendance / Roll Call", renderAttendance],
            ["Score Entry", renderScoreEntry],
            ["Teacher / Principal Comments", renderComments],
            ["Student Registration", renderStudentRegistration],
            ["Sync Status & Conflicts", renderSyncStatus],
        ];
        for (const [label, fn] of items) {
            const box = el(`<div class="stat-box" style="cursor:pointer;"><div class="label">${label}</div></div>`);
            box.addEventListener("click", fn);
            body.appendChild(box);
        }
        frame("Offline Menu", body);
    }

    // ---------------- helpers shared by views ----------------

    async function accessibleClasses() {
        const classes = await OfflineDB.getAll(schoolId, "classes");
        if (["admin", "sub_admin"].includes(session.user.role)) return classes;
        return classes.filter((c) => c.form_teacher_id === session.user.user_id);
    }

    async function teachingClasses() {
        // classes a teacher has at least one subject assignment in
        if (["admin", "sub_admin"].includes(session.user.role)) return OfflineDB.getAll(schoolId, "classes");
        const links = (await OfflineDB.getAll(schoolId, "class_subjects")).filter((cs) => cs.teacher_id === session.user.user_id);
        const classIds = new Set(links.map((l) => l.class_id));
        const classes = await OfflineDB.getAll(schoolId, "classes");
        return classes.filter((c) => classIds.has(c.id));
    }

    async function activeTerm() {
        const sessions = await OfflineDB.getAll(schoolId, "sessions");
        const activeSession = sessions.find((s) => s.is_active);
        if (!activeSession) return null;
        const terms = await OfflineDB.getAll(schoolId, "terms");
        return terms.find((t) => t.is_active && t.session_id === activeSession.id) || null;
    }

    function backButton() {
        const btn = el(`<button class="btn" style="background:#888; margin-bottom:1rem;">&larr; Back to menu</button>`);
        btn.addEventListener("click", renderHome);
        return btn;
    }

    // ---------------- attendance ----------------

    async function renderAttendance() {
        const body = el(`<div></div>`);
        body.appendChild(backButton());
        const term = await activeTerm();
        if (!term) {
            body.appendChild(el(`<p>No active term found in this device's offline data. Connect to the internet once to sync the current term.</p>`));
            frame("Attendance / Roll Call", body);
            return;
        }
        const classes = await accessibleClasses();
        const controls = el(`
            <div class="card">
                <label>Class</label>
                <select id="classSelect"><option value="">Choose a class…</option>${classes.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}</select>
                <label>Date</label>
                <input type="date" id="dateSelect" value="${todayStr()}">
            </div>
        `);
        body.appendChild(controls);
        const listWrap = el(`<div id="attendanceList"></div>`);
        body.appendChild(listWrap);
        frame("Attendance / Roll Call", body);

        async function renderList() {
            const classId = parseInt(document.getElementById("classSelect").value, 10);
            const date = document.getElementById("dateSelect").value;
            listWrap.innerHTML = "";
            if (!classId || !date) return;
            const students = (await OfflineDB.getAll(schoolId, "students")).filter((s) => s.class_id === classId && s.is_active);
            const records = await OfflineDB.getAll(schoolId, "attendance_records");
            const card = el(`<div class="card"><table><thead><tr><th>Student</th><th>Present</th><th>Absent</th></tr></thead><tbody></tbody></table>
                <button class="btn" id="saveAttendanceBtn" style="margin-top:1rem;">Save Attendance</button></div>`);
            const tbody = card.querySelector("tbody");
            for (const s of students) {
                const existing = records.find((r) => r.student_id === s.id && r.term_id === term.id && r.date === date);
                const current = existing ? existing.status : "present";
                const row = el(`
                    <tr data-student="${s.id}" data-client-uuid="${existing ? existing.client_uuid : ''}">
                        <td>${s.first_name} ${s.last_name}</td>
                        <td><input type="radio" name="att_${s.id}" value="present" ${current === "present" ? "checked" : ""}></td>
                        <td><input type="radio" name="att_${s.id}" value="absent" ${current === "absent" ? "checked" : ""}></td>
                    </tr>
                `);
                tbody.appendChild(row);
            }
            listWrap.appendChild(card);
            card.querySelector("#saveAttendanceBtn").addEventListener("click", async () => {
                for (const row of tbody.querySelectorAll("tr")) {
                    const studentId = parseInt(row.dataset.student, 10);
                    const status = row.querySelector("input[type=radio]:checked").value;
                    const clientUuid = row.dataset.clientUuid;
                    const data = { student_id: studentId, class_id: classId, term_id: term.id, date, status, recorded_by: session.user.user_id };
                    if (clientUuid) {
                        await SyncEngine.queueChange(schoolId, "attendance_records", "update", data, clientUuid);
                    } else {
                        await SyncEngine.queueChange(schoolId, "attendance_records", "create", data);
                    }
                }
                alert("Attendance saved on this device. It will sync automatically once you're back online.");
                renderList();
            });
        }
        document.getElementById("classSelect").addEventListener("change", renderList);
        document.getElementById("dateSelect").addEventListener("change", renderList);
    }

    // ---------------- score entry ----------------

    async function renderScoreEntry() {
        const body = el(`<div></div>`);
        body.appendChild(backButton());
        const term = await activeTerm();
        if (!term) {
            body.appendChild(el(`<p>No active term found in this device's offline data. Connect to the internet once to sync the current term.</p>`));
            frame("Score Entry", body);
            return;
        }
        const classes = await teachingClasses();
        const controls = el(`
            <div class="card">
                <label>Class</label>
                <select id="seClassSelect"><option value="">Choose a class…</option>${classes.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}</select>
                <label>Subject</label>
                <select id="seSubjectSelect"><option value="">Choose a class first…</option></select>
            </div>
        `);
        body.appendChild(controls);
        const listWrap = el(`<div id="scoreList"></div>`);
        body.appendChild(listWrap);
        frame("Score Entry", body);

        document.getElementById("seClassSelect").addEventListener("change", async () => {
            const classId = parseInt(document.getElementById("seClassSelect").value, 10);
            const subjectSelect = document.getElementById("seSubjectSelect");
            subjectSelect.innerHTML = "";
            listWrap.innerHTML = "";
            if (!classId) return;
            const links = (await OfflineDB.getAll(schoolId, "class_subjects")).filter((cs) => cs.class_id === classId &&
                (["admin", "sub_admin"].includes(session.user.role) || cs.teacher_id === session.user.user_id));
            const subjects = await OfflineDB.getAll(schoolId, "subjects");
            subjectSelect.innerHTML = `<option value="">Choose a subject…</option>` +
                links.map((l) => { const subj = subjects.find((s) => s.id === l.subject_id); return subj ? `<option value="${subj.id}">${subj.name}</option>` : ""; }).join("");
        });

        document.getElementById("seSubjectSelect").addEventListener("change", async () => {
            const classId = parseInt(document.getElementById("seClassSelect").value, 10);
            const subjectId = parseInt(document.getElementById("seSubjectSelect").value, 10);
            listWrap.innerHTML = "";
            if (!classId || !subjectId) return;
            const students = (await OfflineDB.getAll(schoolId, "students")).filter((s) => s.class_id === classId && s.is_active);
            const scores = await OfflineDB.getAll(schoolId, "scores");
            const card = el(`<div class="card"><table><thead><tr><th>Student</th><th>CA1</th><th>CA2</th><th>Exam</th></tr></thead><tbody></tbody></table>
                <button class="btn" id="saveScoresBtn" style="margin-top:1rem;">Save Scores</button></div>`);
            const tbody = card.querySelector("tbody");
            for (const s of students) {
                const existing = scores.find((r) => r.student_id === s.id && r.subject_id === subjectId && r.term_id === term.id);
                const row = el(`
                    <tr data-student="${s.id}" data-client-uuid="${existing ? existing.client_uuid : ''}">
                        <td>${s.first_name} ${s.last_name}</td>
                        <td><input type="number" step="0.5" min="0" style="width:5rem;" class="ca1" value="${existing ? existing.ca1 : ''}"></td>
                        <td><input type="number" step="0.5" min="0" style="width:5rem;" class="ca2" value="${existing ? existing.ca2 : ''}"></td>
                        <td><input type="number" step="0.5" min="0" style="width:5rem;" class="exam" value="${existing ? existing.exam : ''}"></td>
                    </tr>
                `);
                tbody.appendChild(row);
            }
            listWrap.appendChild(card);
            card.querySelector("#saveScoresBtn").addEventListener("click", async () => {
                for (const row of tbody.querySelectorAll("tr")) {
                    const studentId = parseInt(row.dataset.student, 10);
                    const clientUuid = row.dataset.clientUuid;
                    const data = {
                        student_id: studentId, subject_id: subjectId, term_id: term.id,
                        ca1: parseFloat(row.querySelector(".ca1").value) || 0,
                        ca2: parseFloat(row.querySelector(".ca2").value) || 0,
                        exam: parseFloat(row.querySelector(".exam").value) || 0,
                    };
                    if (clientUuid) {
                        await SyncEngine.queueChange(schoolId, "scores", "update", data, clientUuid);
                    } else {
                        await SyncEngine.queueChange(schoolId, "scores", "create", data);
                    }
                }
                alert("Scores saved on this device. They will sync automatically once you're back online.");
            });
        });
    }

    // ---------------- teacher / principal comments ----------------

    async function renderComments() {
        const body = el(`<div></div>`);
        body.appendChild(backButton());
        const term = await activeTerm();
        if (!term) {
            body.appendChild(el(`<p>No active term found in this device's offline data. Connect to the internet once to sync the current term.</p>`));
            frame("Teacher / Principal Comments", body);
            return;
        }
        const isAdmin = ["admin", "sub_admin"].includes(session.user.role);
        const classes = await accessibleClasses();
        const controls = el(`
            <div class="card">
                <label>Class</label>
                <select id="cClassSelect"><option value="">Choose a class…</option>${classes.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}</select>
            </div>
        `);
        body.appendChild(controls);
        const listWrap = el(`<div id="commentList"></div>`);
        body.appendChild(listWrap);
        frame("Teacher / Principal Comments", body);

        document.getElementById("cClassSelect").addEventListener("change", async () => {
            const classId = parseInt(document.getElementById("cClassSelect").value, 10);
            listWrap.innerHTML = "";
            if (!classId) return;
            const students = (await OfflineDB.getAll(schoolId, "students")).filter((s) => s.class_id === classId && s.is_active);
            const infos = await OfflineDB.getAll(schoolId, "student_term_info");
            for (const s of students) {
                const existing = infos.find((r) => r.student_id === s.id && r.term_id === term.id);
                const card = el(`
                    <div class="card" data-student="${s.id}" data-client-uuid="${existing ? existing.client_uuid : ''}">
                        <h4>${s.first_name} ${s.last_name}</h4>
                        <label>Teacher's Comment</label>
                        <textarea class="teacherComment" rows="2" ${isAdmin ? "" : ""}>${existing && existing.teacher_comment ? existing.teacher_comment : ""}</textarea>
                        ${isAdmin ? `
                        <label>Principal's Comment</label>
                        <textarea class="principalComment" rows="2">${existing && existing.principal_comment ? existing.principal_comment : ""}</textarea>` : ""}
                        <button class="btn btn-small saveCommentBtn" style="margin-top:0.5rem;">Save</button>
                        <span class="saveMsg" style="margin-left:0.5rem; color:#2e7d4f;"></span>
                    </div>
                `);
                listWrap.appendChild(card);
                card.querySelector(".saveCommentBtn").addEventListener("click", async () => {
                    const clientUuid = card.dataset.clientUuid;
                    const data = { student_id: s.id, term_id: term.id, teacher_comment: card.querySelector(".teacherComment").value };
                    if (isAdmin) data.principal_comment = card.querySelector(".principalComment").value;
                    if (clientUuid) {
                        await SyncEngine.queueChange(schoolId, "student_term_info", "update", data, clientUuid);
                    } else {
                        const record = await SyncEngine.queueChange(schoolId, "student_term_info", "create", data);
                        card.dataset.clientUuid = record.client_uuid;
                    }
                    card.querySelector(".saveMsg").textContent = "Saved — will sync when online.";
                });
            }
        });
    }

    // ---------------- student registration ----------------

    async function renderStudentRegistration() {
        const body = el(`<div></div>`);
        body.appendChild(backButton());
        const classes = await accessibleClasses();
        const card = el(`
            <div class="card">
                <label>Admission No.</label><input type="text" id="regAdmissionNo">
                <label>First Name</label><input type="text" id="regFirstName">
                <label>Last Name</label><input type="text" id="regLastName">
                <label>Gender</label>
                <select id="regGender"><option value="M">Male</option><option value="F">Female</option></select>
                <label>Class</label>
                <select id="regClass">${classes.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}</select>
                <button class="btn" id="regSaveBtn" style="margin-top:1rem;">Register Student</button>
                <p id="regMsg" style="color:#2e7d4f;"></p>
            </div>
        `);
        body.appendChild(card);
        frame("Student Registration", body);

        document.getElementById("regSaveBtn").addEventListener("click", async () => {
            const data = {
                admission_no: document.getElementById("regAdmissionNo").value.trim(),
                first_name: document.getElementById("regFirstName").value.trim(),
                last_name: document.getElementById("regLastName").value.trim(),
                gender: document.getElementById("regGender").value,
                class_id: parseInt(document.getElementById("regClass").value, 10),
                is_active: 1,
            };
            if (!data.admission_no || !data.first_name || !data.last_name || !data.class_id) {
                document.getElementById("regMsg").style.color = "#b3261e";
                document.getElementById("regMsg").textContent = "Please fill in all fields.";
                return;
            }
            await SyncEngine.queueChange(schoolId, "students", "create", data);
            document.getElementById("regMsg").style.color = "#2e7d4f";
            document.getElementById("regMsg").textContent = "Saved on this device — will sync when back online.";
            document.getElementById("regAdmissionNo").value = "";
            document.getElementById("regFirstName").value = "";
            document.getElementById("regLastName").value = "";
        });
    }

    // ---------------- sync status ----------------

    async function renderSyncStatus() {
        const body = el(`<div></div>`);
        body.appendChild(backButton());
        const syncBtn = el(`<button class="btn" style="margin-bottom:1rem;">Sync Now</button>`);
        syncBtn.addEventListener("click", async () => {
            const s = OfflineAuth.getSession();
            await SyncEngine.syncNow(schoolId, s.device_id, s.device_secret);
            renderSyncStatus();
        });
        body.appendChild(syncBtn);

        for (const entity of OfflineDB.ENTITY_STORES) {
            for (const status of ["pending", "failed", "conflict"]) {
                const rows = await OfflineDB.getByStatus(schoolId, entity, status);
                if (!rows.length) continue;
                const section = el(`<div class="card"><h3>${entity} — ${rows.length} ${status}</h3></div>`);
                for (const row of rows) {
                    const line = el(`<div style="border-top:1px solid #eee; padding:0.5rem 0;">
                        <code>${row.client_uuid.slice(0, 8)}</code> ${row._sync.last_error ? `— ${row._sync.last_error}` : ""}
                    </div>`);
                    if (status === "conflict") {
                        const keepMine = el(`<button class="btn btn-small">Keep mine</button>`);
                        const keepServer = el(`<button class="btn btn-small" style="background:#888;">Keep server's</button>`);
                        keepMine.addEventListener("click", async () => { await SyncEngine.resolveConflict(schoolId, entity, row.client_uuid, true); renderSyncStatus(); });
                        keepServer.addEventListener("click", async () => { await SyncEngine.resolveConflict(schoolId, entity, row.client_uuid, false); renderSyncStatus(); });
                        line.appendChild(keepMine);
                        line.appendChild(keepServer);
                    }
                    section.appendChild(line);
                }
                body.appendChild(section);
            }
        }
        if (!body.querySelectorAll(".card").length - 0) { /* noop, syncBtn card already counted */ }
        frame("Sync Status & Conflicts", body);
    }

    boot();
})();
