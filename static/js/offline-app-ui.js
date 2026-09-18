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
        const isAdmin = ["admin", "sub_admin"].includes(session.user.role);
        const items = [
            ["Attendance / Roll Call", renderAttendance],
            ["Score Entry", renderScoreEntry],
            ["Teacher / Principal Comments", renderComments],
            ["Student Registration", renderStudentRegistration],
        ];
        if (isAdmin) {
            items.push(
                ["Manage Classes", renderClassManagement],
                ["Manage Subjects", renderSubjectManagement],
                ["Manage Teachers / Staff", renderTeacherManagement],
                ["Queue Internet-Only Actions", renderActionsQueue],
            );
        }
        items.push(["Sync Status & Conflicts", renderSyncStatus]);
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

    // ---------------- dependency-safe references ----------------
    // A record created offline (e.g. a brand-new class) doesn't have a
    // real numeric id yet — only a client_uuid — until it syncs. These
    // helpers let a <select> offer such "still syncing" parent records
    // alongside already-synced ones, and turn whichever one was picked
    // into either a real foreign key or a `_pending_refs` entry that
    // SyncEngine resolves automatically once the parent syncs (see
    // "Dependency-safe offline creation" in OFFLINE_ARCHITECTURE.md).

    function refKey(record) {
        return record.id ? String(record.id) : `pending:${record.client_uuid}`;
    }

    function refOptions(records, labelFn) {
        return records.map((r) => `<option value="${refKey(r)}">${labelFn(r)}${r.id ? "" : " (not yet synced)"}</option>`).join("");
    }

    // Reads a <select> populated by refOptions() and applies the choice
    // either as a resolved numeric field on `data`, or as an entry in
    // `pendingRefs` for SyncEngine to resolve later. `data` and
    // `pendingRefs` are mutated in place.
    function applyRefSelection(selectValue, fieldName, parentEntity, data, pendingRefs) {
        if (!selectValue) return;
        if (selectValue.startsWith("pending:")) {
            pendingRefs[fieldName] = `${parentEntity}:${selectValue.slice("pending:".length)}`;
        } else {
            data[fieldName] = parseInt(selectValue, 10);
        }
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
        if (!classes.length) {
            body.appendChild(el(`<p>No classes available yet on this device. ${["admin","sub_admin"].includes(session.user.role) ? "Add one under \"Manage Classes\" first — you can do that offline too." : "Ask an admin to set one up."}</p>`));
            frame("Student Registration", body);
            return;
        }
        const card = el(`
            <div class="card">
                <label>Admission No.</label><input type="text" id="regAdmissionNo">
                <label>First Name</label><input type="text" id="regFirstName">
                <label>Last Name</label><input type="text" id="regLastName">
                <label>Gender</label>
                <select id="regGender"><option value="M">Male</option><option value="F">Female</option></select>
                <label>Class</label>
                <select id="regClass">${refOptions(classes, (c) => c.name)}</select>
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
                is_active: 1,
            };
            const pendingRefs = {};
            applyRefSelection(document.getElementById("regClass").value, "class_id", "classes", data, pendingRefs);
            if (!data.admission_no || !data.first_name || !data.last_name || (!data.class_id && !pendingRefs.class_id)) {
                document.getElementById("regMsg").style.color = "#b3261e";
                document.getElementById("regMsg").textContent = "Please fill in all fields.";
                return;
            }
            await SyncEngine.queueChange(schoolId, "students", "create", data, undefined, pendingRefs);
            document.getElementById("regMsg").style.color = "#2e7d4f";
            document.getElementById("regMsg").textContent = pendingRefs.class_id
                ? "Saved on this device. This student's class hasn't synced yet either — both will sync together once you're back online."
                : "Saved on this device — will sync when back online.";
            document.getElementById("regAdmissionNo").value = "";
            document.getElementById("regFirstName").value = "";
            document.getElementById("regLastName").value = "";
        });
    }

    // ---------------- class / subject / teacher management (admin only) ----------------

    async function renderClassManagement() {
        const body = el(`<div></div>`);
        body.appendChild(backButton());
        const classes = await OfflineDB.getAll(schoolId, "classes");
        const teachers = (await OfflineDB.getAll(schoolId, "users")).filter((u) => u.role === "teacher");
        const listCard = el(`<div class="card"><h3>Existing Classes</h3><table><thead><tr><th>Name</th><th>Category</th><th>Status</th></tr></thead><tbody>
            ${classes.map((c) => `<tr><td>${c.name}</td><td>${c.category || "—"}</td><td>${c._sync.status === "synced" ? "Synced" : "Pending sync"}</td></tr>`).join("")}
        </tbody></table></div>`);
        body.appendChild(listCard);

        const CLASS_CATEGORIES = ["", "Science", "Arts", "Commercial"]; // must mirror CLASS_CATEGORIES in db.py
        const formCard = el(`
            <div class="card">
                <h3>Add a Class</h3>
                <label>Name</label><input type="text" id="clsName" placeholder="e.g. JSS 1A">
                <label>Category (optional)</label>
                <select id="clsCategory">${CLASS_CATEGORIES.map((c) => `<option value="${c}">${c || "None"}</option>`).join("")}</select>
                <label>Form Teacher (optional)</label>
                <select id="clsFormTeacher"><option value="">None</option>${refOptions(teachers, (t) => t.name)}</select>
                <button class="btn" id="clsSaveBtn" style="margin-top:1rem;">Add Class</button>
                <p id="clsMsg" style="color:#2e7d4f;"></p>
            </div>
        `);
        body.appendChild(formCard);
        frame("Manage Classes", body);

        document.getElementById("clsSaveBtn").addEventListener("click", async () => {
            const name = document.getElementById("clsName").value.trim();
            const msg = document.getElementById("clsMsg");
            if (!name) { msg.style.color = "#b3261e"; msg.textContent = "Class name is required."; return; }
            const data = { name, category: document.getElementById("clsCategory").value || null };
            const pendingRefs = {};
            const teacherVal = document.getElementById("clsFormTeacher").value;
            if (teacherVal) applyRefSelection(teacherVal, "form_teacher_id", "users", data, pendingRefs);
            await SyncEngine.queueChange(schoolId, "classes", "create", data, undefined, pendingRefs);
            msg.style.color = "#2e7d4f";
            msg.textContent = "Saved on this device — will sync when back online.";
            renderClassManagement();
        });
    }

    async function renderSubjectManagement() {
        const body = el(`<div></div>`);
        body.appendChild(backButton());
        const subjects = await OfflineDB.getAll(schoolId, "subjects");
        const listCard = el(`<div class="card"><h3>Existing Subjects</h3><table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody>
            ${subjects.map((s) => `<tr><td>${s.name}</td><td>${s._sync.status === "synced" ? "Synced" : "Pending sync"}</td></tr>`).join("")}
        </tbody></table></div>`);
        body.appendChild(listCard);
        const formCard = el(`
            <div class="card">
                <h3>Add a Subject</h3>
                <label>Name</label><input type="text" id="subjName" placeholder="e.g. Further Mathematics">
                <button class="btn" id="subjSaveBtn" style="margin-top:1rem;">Add Subject</button>
                <p id="subjMsg" style="color:#2e7d4f;"></p>
            </div>
        `);
        body.appendChild(formCard);
        frame("Manage Subjects", body);

        document.getElementById("subjSaveBtn").addEventListener("click", async () => {
            const name = document.getElementById("subjName").value.trim();
            const msg = document.getElementById("subjMsg");
            if (!name) { msg.style.color = "#b3261e"; msg.textContent = "Subject name is required."; return; }
            await SyncEngine.queueChange(schoolId, "subjects", "create", { name });
            msg.style.color = "#2e7d4f";
            msg.textContent = "Saved on this device — will sync when back online.";
            renderSubjectManagement();
        });
    }

    async function renderTeacherManagement() {
        const body = el(`<div></div>`);
        body.appendChild(backButton());
        const staff = (await OfflineDB.getAll(schoolId, "users")).filter((u) => u.role !== "admin");
        const listCard = el(`<div class="card"><h3>Existing Teachers / Staff</h3><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th></tr></thead><tbody>
            ${staff.map((u) => `<tr><td>${u.name}</td><td>${u.username}</td><td>${u.role}</td><td>${u._sync.status === "synced" ? "Synced" : "Pending sync"}</td></tr>`).join("")}
        </tbody></table></div>`);
        body.appendChild(listCard);

        // Mirrors POSITION_LABELS in db.py.
        const POSITIONS = { "": "None", principal: "Principal", vice_principal: "Vice Principal", exam_officer: "Exam Officer", subject_teacher: "Subject Teacher", form_teacher: "Form Teacher" };
        const canMakeSubAdmin = session.user.role === "admin";
        const formCard = el(`
            <div class="card">
                <h3>Add a Teacher / Staff Member</h3>
                <label>Full Name</label><input type="text" id="tName">
                <label>Username</label><input type="text" id="tUsername">
                <label>Password</label><input type="password" id="tPassword">
                <label>Position (optional)</label>
                <select id="tPosition">${Object.entries(POSITIONS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
                ${canMakeSubAdmin ? `<label>Role</label><select id="tRole"><option value="teacher">Teacher</option><option value="sub_admin">Sub-Admin</option></select>` : ""}
                <button class="btn" id="tSaveBtn" style="margin-top:1rem;">Add Staff Member</button>
                <p id="tMsg" style="color:#2e7d4f;"></p>
                <p style="font-size:0.8rem; color:#888;">Usernames must be unique across the whole platform, which this device can't fully verify offline — if someone else has already taken this username, you'll see it flagged as a conflict once this syncs.</p>
            </div>
        `);
        body.appendChild(formCard);
        frame("Manage Teachers / Staff", body);

        document.getElementById("tSaveBtn").addEventListener("click", async () => {
            const msg = document.getElementById("tMsg");
            const name = document.getElementById("tName").value.trim();
            const username = document.getElementById("tUsername").value.trim();
            const password = document.getElementById("tPassword").value;
            if (!name || !username || !password) { msg.style.color = "#b3261e"; msg.textContent = "Name, username, and password are all required."; return; }
            const data = {
                name, username, password,
                position: document.getElementById("tPosition").value || null,
                role: canMakeSubAdmin ? document.getElementById("tRole").value : "teacher",
            };
            await SyncEngine.queueChange(schoolId, "users", "create", data);
            msg.style.color = "#2e7d4f";
            msg.textContent = "Saved on this device — will sync when back online.";
            renderTeacherManagement();
        });
    }

    // ---------------- internet-only actions queue ----------------

    async function renderActionsQueue() {
        const body = el(`<div></div>`);
        body.appendChild(backButton());
        body.appendChild(el(`<p style="color:#666;">Some things — like emailing results to parents — genuinely need
            a live internet connection. Queue them here while offline; they'll run automatically,
            using this device's regular sync connection, the next time you're online.</p>`));
        const term = await activeTerm();
        // Emailing results needs a class that already exists server-side
        // (results are computed from data the server holds), so unlike
        // other offline screens, a not-yet-synced class isn't offered here.
        const classes = (await OfflineDB.getAll(schoolId, "classes")).filter((c) => c.id);
        if (!term || !classes.length) {
            body.appendChild(el(`<p>No synced classes/term available yet on this device — connect once online first.</p>`));
            frame("Queue Internet-Only Actions", body);
            return;
        }
        const formCard = el(`
            <div class="card">
                <h3>Email Results to Parents</h3>
                <label>Class</label>
                <select id="actClassSelect">${classes.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}</select>
                <button class="btn" id="actQueueBtn" style="margin-top:1rem;">Queue for Next Sync</button>
                <p id="actMsg" style="color:#2e7d4f;"></p>
            </div>
        `);
        body.appendChild(formCard);
        const queuedCard = el(`<div class="card"><h3>Queued Actions</h3><div id="queuedList"></div></div>`);
        body.appendChild(queuedCard);
        frame("Queue Internet-Only Actions", body);

        async function refreshQueuedList() {
            const actions = await OfflineDB.getAll(schoolId, "actions");
            const list = document.getElementById("queuedList");
            list.innerHTML = actions.length ? "" : "<p>Nothing queued.</p>";
            for (const a of actions) {
                const statusLabel = a._sync.status === "synced" ? "Done" : a._sync.status === "failed" ? "Failed — will retry" : "Waiting to sync";
                list.appendChild(el(`<div style="border-top:1px solid #eee; padding:0.4rem 0;">
                    ${a.action_type} (class ${a.payload.class_id}) — ${statusLabel}
                    ${a._sync.result_message ? `<br><span style="font-size:0.8rem; color:#888;">${a._sync.result_message}</span>` : ""}
                    ${a._sync.last_error ? `<br><span style="font-size:0.8rem; color:#b3261e;">${a._sync.last_error}</span>` : ""}
                </div>`));
            }
        }
        await refreshQueuedList();

        document.getElementById("actQueueBtn").addEventListener("click", async () => {
            const classId = parseInt(document.getElementById("actClassSelect").value, 10);
            await SyncEngine.queueAction(schoolId, "email_class_results", { class_id: classId, term_id: term.id });
            document.getElementById("actMsg").textContent = "Queued — will run automatically once this device is back online.";
            await refreshQueuedList();
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
                    const waitingOn = row._pending_refs
                        ? `Waiting on: ${Object.values(row._pending_refs).map((v) => v.split(":")[0]).join(", ")} to sync first`
                        : "";
                    const line = el(`<div style="border-top:1px solid #eee; padding:0.5rem 0;">
                        <code>${row.client_uuid.slice(0, 8)}</code>
                        ${waitingOn ? `<span style="color:#a97f22;"> — ${waitingOn}</span>` : ""}
                        ${row._sync.last_error ? `<span style="color:#b3261e;"> — ${row._sync.last_error}</span>` : ""}
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
